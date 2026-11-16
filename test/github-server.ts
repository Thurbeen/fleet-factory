import { createServer } from 'node:http';

type Comment = { id: number; user: { login: string }; body: string };
type Issue = {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: Comment[];
  pull_request?: object;
};
type State = {
  issues: Record<string, Issue>;
  permissions: Record<string, string>;
  token: string;
  login: string;
  nextId: number;
  throttle: boolean;
};

const state: State = {
  issues: {},
  permissions: {},
  token: 'test-token',
  login: 'factory-bot',
  nextId: 1000,
  throttle: false,
};

function send(res: any, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify(body));
}

function issueJson(project: string, i: Issue) {
  return {
    number: i.number,
    html_url: `https://github.test/${project}/issues/${i.number}`,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((name) => ({ name })),
    ...(i.pull_request ? { pull_request: i.pull_request } : {}),
  };
}

const server = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  if (path === '/__state') {
    if (req.method === 'PUT') Object.assign(state, body);
    return send(res, 200, state);
  }
  if (req.headers.authorization !== `Bearer ${state.token}`) return send(res, 401, {});
  if (state.throttle) return send(res, 403, { message: 'API rate limit exceeded' });
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
    return send(res, 200, i.comments);
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
