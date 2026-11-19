import { spawn } from 'node:child_process';
import { createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';

type User = { login: string; type?: string };
type Comment = { id: number; user: User; body: string };
type Issue = {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: Comment[];
  user?: User;
  pull_request?: object;
};
type Request = { method: string; path: string; authorization: string | null; accepted: boolean };
type State = {
  issues: Record<string, Issue>;
  permissions: Record<string, string>;
  token: string;
  login: string;
  nextId: number;
  throttle: boolean;
  app: { id: string; installationId: string; publicKey: string } | null;
  minted: number;
  tokens: Record<string, number>;
  tokenTtlMs: number;
  requests: Request[];
  pulls: Record<string, { head: string }>;
  autoMerges: { id: string; head: string }[];
  created: { project: string; title: string }[];
  guardrails: { allowAutoMerge: boolean; rules: object[] };
  gitRoot: string | null;
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
  tokens: {},
  tokenTtlMs: 3_600_000,
  requests: [],
  pulls: {},
  autoMerges: [],
  created: [],
  guardrails: { allowAutoMerge: false, rules: [] },
  gitRoot: null,
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

function bearer(authorization: string | undefined): string | null {
  const m = /^(?:Bearer|token) (.+)$/.exec(authorization ?? '');
  if (m) return m[1];
  const basic = /^Basic (.+)$/.exec(authorization ?? '');
  if (!basic) return null;
  const decoded = Buffer.from(basic[1], 'base64').toString();
  return decoded.slice(decoded.indexOf(':') + 1);
}

function accepted(authorization: string | undefined): boolean {
  const token = bearer(authorization);
  if (!token) return false;
  if (token === state.token) return true;
  return (state.tokens[token] ?? 0) > Date.now();
}

function send(res: ServerResponse, code: number, body: unknown, headers: object = {}) {
  res.writeHead(code, { 'content-type': 'application/json', connection: 'close', ...headers });
  res.end(JSON.stringify(body));
}

const user = (u: User | undefined) => ({ type: 'User', ...(u ?? { login: '' }) });

function issueJson(project: string, i: Issue) {
  return {
    number: i.number,
    html_url: `https://github.test/${project}/issues/${i.number}`,
    title: i.title,
    body: i.body,
    state: i.state,
    user: user(i.user),
    labels: i.labels.map((name) => ({ name })),
    ...(i.pull_request ? { pull_request: i.pull_request } : {}),
  };
}

function gitBackend(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: string,
  raw: Buffer,
) {
  const backend = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH ?? '',
      GIT_PROJECT_ROOT: state.gitRoot ?? '',
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: path,
      QUERY_STRING: query,
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: String(raw.length),
      HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
      GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
      REMOTE_USER: 'x-access-token',
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  const out: Buffer[] = [];
  backend.stdout.on('data', (d) => out.push(d));
  backend.stdin.end(raw);
  backend.on('close', () => {
    const all = Buffer.concat(out);
    const split = all.indexOf('\r\n\r\n');
    const head = all.subarray(0, split).toString().split('\r\n');
    const headers: Record<string, string> = {};
    let code = 200;
    for (const line of head) {
      const [k, ...v] = line.split(':');
      if (k.toLowerCase() === 'status') code = Number(v.join(':').trim().split(' ')[0]);
      else headers[k] = v.join(':').trim();
    }
    res.writeHead(code, headers);
    res.end(all.subarray(split + 4));
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  if (path === '/__state') {
    if (req.method === 'PUT') Object.assign(state, JSON.parse(raw.toString()));
    return send(res, 200, state);
  }
  state.requests.push({
    method: req.method ?? '',
    path,
    authorization: req.headers.authorization ?? null,
    accepted: accepted(req.headers.authorization),
  });
  if (/\.git\//.test(path)) {
    if (!accepted(req.headers.authorization))
      return send(res, 401, {}, { 'www-authenticate': 'Basic realm="GitHub"' });
    return gitBackend(req, res, path, url.search.slice(1), raw);
  }
  const body = raw.length ? JSON.parse(raw.toString()) : null;
  const mint = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(path);
  if (mint && req.method === 'POST') {
    if (!appJwtValid(req.headers.authorization) || mint[1] !== state.app?.installationId)
      return send(res, 401, { message: 'A JSON web token could not be decoded' });
    state.minted += 1;
    const token = `ghs_minted_${state.minted}`;
    const expires = Date.now() + state.tokenTtlMs;
    state.tokens[token] = expires;
    return send(res, 201, { token, expires_at: new Date(expires).toISOString() });
  }
  if (!accepted(req.headers.authorization)) return send(res, 401, { message: 'Bad credentials' });
  if (state.throttle) return send(res, 403, { message: 'API rate limit exceeded' });
  if (path === '/graphql' && req.method === 'POST') {
    const v = body.variables ?? {};
    if (/enablePullRequestAutoMerge/.test(body.query)) {
      state.autoMerges.push({ id: v.id, head: v.h });
      return send(res, 200, { data: { enablePullRequestAutoMerge: { clientMutationId: null } } });
    }
    const pull = state.pulls[`${v.o}/${v.r}#${v.n}`];
    return send(res, 200, {
      data: {
        repository: {
          pullRequest: pull ? { id: `PR_${v.o}/${v.r}#${v.n}`, headRefOid: pull.head } : null,
        },
      },
    });
  }
  let m = /^\/repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(path);
  if (!m) return send(res, 404, {});
  const [, project, rest = ''] = m;
  const issue = (n: string) => state.issues[`${project}#${n}`];
  if (rest === '' && req.method === 'GET')
    return send(res, 200, {
      full_name: project,
      allow_auto_merge: state.guardrails.allowAutoMerge,
    });
  if (/^rules\/branches\//.test(rest)) return send(res, 200, state.guardrails.rules);
  if (rest === 'pulls' && req.method === 'POST') {
    state.created.push({ project, title: body.title });
    return send(res, 201, { number: 11, html_url: `https://github.test/${project}/pull/11` });
  }
  if ((m = /^pulls\/(\d+)$/.exec(rest)))
    return send(res, 200, { number: Number(m[1]), state: 'open' });
  if (rest === 'issues' && req.method === 'GET') {
    const label = url.searchParams.get('labels');
    const list = Object.entries(state.issues)
      .filter(([k, i]) => k.startsWith(`${project}#`) && i.state === 'open')
      .filter(([, i]) => !label || i.labels.includes(label))
      .map(([, i]) => issueJson(project, i));
    return send(res, 200, list);
  }
  if ((m = /^collaborators\/([^/]+)\/permission$/.exec(rest)))
    return send(res, 200, {
      permission: state.permissions[decodeURIComponent(m[1])] ?? 'none',
    });
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
      const c = {
        id: state.nextId++,
        user: { login: state.login, type: 'Bot' },
        body: body.body,
      };
      i.comments.push(c);
      return send(res, 201, c);
    }
    return send(
      res,
      200,
      i.comments.map((c) => ({ ...c, user: user(c.user) })),
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
}

const [keyFile, certFile] = process.argv.slice(2);
const server = createServer(handle);
const tls = keyFile
  ? createTlsServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, handle)
  : null;

const port = (s: { address(): unknown }) => (s.address() as { port: number }).port;
server.listen(0, '127.0.0.1', () => {
  if (!tls) return process.stdout.write(`${port(server)}\n`);
  tls.listen(0, '127.0.0.1', () => process.stdout.write(`${port(server)} ${port(tls)}\n`));
});
