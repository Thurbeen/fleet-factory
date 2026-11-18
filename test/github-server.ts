import { spawn } from 'node:child_process';
import { createVerify } from 'node:crypto';
import { createServer } from 'node:http';

type Account = { login: string; type?: string };
type Comment = { id: number; user: Account; body: string };
type Issue = {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: Comment[];
  user?: Account;
  pull_request?: object;
};
type Request = { method: string; path: string; credential: string };
type State = {
  issues: Record<string, Issue>;
  permissions: Record<string, string>;
  token: string;
  login: string;
  nextId: number;
  throttle: boolean;
  app: { id: string; installationId: string; publicKey: string } | null;
  minted: number;
  gitRoot: string | null;
  requests: Request[];
};

const state: State = {
  issues: {},
  permissions: {},
  token: 'test-token',
  login: 'factory-bot',
  nextId: 1000,
  throttle: false,
  app: null,
  minted: 0,
  gitRoot: null,
  requests: [],
};

function appJwtValid(authorization: string | undefined): boolean {
  const app = state.app;
  const m = /^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(authorization ?? '');
  if (!app || !m) return false;
  const verify = createVerify('RSA-SHA256');
  verify.update(`${m[1]}.${m[2]}`);
  if (!verify.verify(app.publicKey, Buffer.from(m[3], 'base64url'))) return false;
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  const now = Date.now() / 1000;
  return String(claims.iss) === app.id && claims.iat <= now && claims.exp > now;
}

function credential(authorization: string | undefined): string {
  const bearer = /^Bearer (.+)$/.exec(authorization ?? '');
  if (bearer) return bearer[1];
  const basic = /^Basic (.+)$/.exec(authorization ?? '');
  if (!basic) return '';
  const [, password = ''] = /^[^:]*:(.*)$/.exec(Buffer.from(basic[1], 'base64').toString()) ?? [];
  return password;
}

function accepted(token: string): boolean {
  const minted = /^ghs_minted_(\d+)$/.exec(token);
  return token === state.token || (!!minted && Number(minted[1]) <= state.minted);
}

function send(res: any, code: number, body: unknown, headers: object = {}) {
  res.writeHead(code, { 'content-type': 'application/json', connection: 'close', ...headers });
  res.end(JSON.stringify(body));
}

const account = (a: Account | undefined) => ({ type: 'User', ...(a ?? { login: 'someone' }) });

function issueJson(project: string, i: Issue) {
  return {
    number: i.number,
    html_url: `https://github.test/${project}/issues/${i.number}`,
    title: i.title,
    body: i.body,
    state: i.state,
    user: account(i.user),
    labels: i.labels.map((name) => ({ name })),
    ...(i.pull_request ? { pull_request: i.pull_request } : {}),
  };
}

function gitBackend(req: any, res: any, path: string, query: string, body: Buffer) {
  const cgi = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH ?? '',
      GIT_PROJECT_ROOT: state.gitRoot!,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: path,
      QUERY_STRING: query,
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: String(body.length),
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
      REMOTE_USER: 'x-access-token',
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  const out: Buffer[] = [];
  cgi.stdout.on('data', (d) => out.push(d));
  cgi.stdin.end(body);
  cgi.on('close', () => {
    const all = Buffer.concat(out);
    const split = all.indexOf('\r\n\r\n');
    const head = all.subarray(0, split).toString();
    const headers: Record<string, string> = { connection: 'close' };
    let code = 200;
    for (const line of head.split('\r\n')) {
      const [k, ...v] = line.split(':');
      if (k.toLowerCase() === 'status') code = Number(v.join(':').trim().split(' ')[0]);
      else headers[k] = v.join(':').trim();
    }
    res.writeHead(code, headers);
    res.end(all.subarray(split + 4));
  });
}

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  if (path === '/__state') {
    if (req.method === 'PUT') Object.assign(state, JSON.parse(raw.toString()));
    return send(res, 200, state);
  }
  const mint = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(path);
  if (mint && req.method === 'POST') {
    if (!appJwtValid(req.headers.authorization) || mint[1] !== state.app?.installationId)
      return send(res, 401, { message: 'A JSON web token could not be decoded' });
    state.minted += 1;
    return send(res, 201, {
      token: `ghs_minted_${state.minted}`,
      expires_at: '2099-01-01T00:00:00Z',
    });
  }
  const token = credential(req.headers.authorization);
  state.requests.push({ method: req.method ?? '', path, credential: token });
  if (/^\/[^/]+\/[^/]+\.git\//.test(path) && state.gitRoot) {
    if (!accepted(token))
      return send(res, 401, {}, { 'www-authenticate': 'Basic realm="github.test"' });
    return gitBackend(req, res, path, url.search.slice(1), raw);
  }
  if (!accepted(token)) return send(res, 401, {});
  if (state.throttle) return send(res, 403, { message: 'API rate limit exceeded' });
  const body = raw.length ? JSON.parse(raw.toString()) : null;
  let m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(path);
  if (!m) return send(res, 404, {});
  const [, project, rest] = m;
  const issue = (n: string) => state.issues[`${project}#${n}`];
  if (rest === 'issues' && req.method === 'GET') {
    const label = url.searchParams.get('labels');
    const list = Object.entries(state.issues)
      .filter(([k, i]) => k.startsWith(`${project}#`) && i.state === 'open')
      .filter(([, i]) => !label || i.labels.includes(label))
      .map(([, i]) => issueJson(project, i));
    return send(res, 200, list);
  }
  if ((m = /^collaborators\/([^/]+)\/permission$/.exec(rest)))
    return send(res, 200, { permission: state.permissions[m[1]] ?? 'none' });
  if ((m = /^issues\/comments\/(\d+)$/.exec(rest)) && req.method === 'PATCH') {
    for (const i of Object.values(state.issues))
      for (const c of i.comments) if (c.id === Number(m[1])) c.body = body.body;
    return send(res, 200, { id: Number(m[1]) });
  }
  if ((m = /^issues\/(\d+)$/.exec(rest))) {
    const i = issue(m[1]);
    return i ? send(res, 200, issueJson(project, i)) : send(res, 404, {});
  }
  if ((m = /^issues\/(\d+)\/comments$/.exec(rest))) {
    const i = issue(m[1]);
    if (!i) return send(res, 404, {});
    if (req.method === 'POST') {
      const c = { id: state.nextId++, user: { login: state.login }, body: body.body };
      i.comments.push(c);
      return send(res, 201, c);
    }
    return send(
      res,
      200,
      i.comments.map((c) => ({ ...c, user: account(c.user) })),
    );
  }
  if ((m = /^issues\/(\d+)\/labels$/.exec(rest)) && req.method === 'POST') {
    const i = issue(m[1]);
    i.labels = [...new Set([...i.labels, ...body.labels])];
    return send(
      res,
      200,
      i.labels.map((name) => ({ name })),
    );
  }
  if ((m = /^issues\/(\d+)\/labels\/(.+)$/.exec(rest)) && req.method === 'DELETE') {
    const i = issue(m[1]);
    const name = decodeURIComponent(m[2]);
    if (!i.labels.includes(name)) return send(res, 404, {});
    i.labels = i.labels.filter((l) => l !== name);
    return send(res, 200, []);
  }
  return send(res, 404, {});
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address === 'object') process.stdout.write(`${address.port}\n`);
});
