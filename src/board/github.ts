import { type Board, type BoardRef, type CommentView, type TicketView, Unknown } from './types.ts';
import { PLUGIN, marker, tokenFrom } from '../util.ts';

const PAGE = 100;
const MAX_PAGES = 10;

function api(ref: BoardRef): string {
  return (ref.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
}

async function call(ref: BoardRef, method: string, path: string, body?: unknown): Promise<any> {
  const token = tokenFrom(ref.tokenEnv);
  let res: Response;
  try {
    res = await fetch(`${api(ref)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Unknown(`GitHub unreachable: ${(e as Error).message}`);
  }
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    const text = await res.text();
    if (/rate limit/i.test(text) || res.status === 429) throw new Unknown('GitHub rate limit');
    throw new Error(`GitHub refused ${method} ${path}: ${res.status}`);
  }
  if (res.status >= 500) throw new Unknown(`GitHub answered ${res.status}`);
  if (!res.ok) throw new Error(`GitHub refused ${method} ${path}: ${res.status}`);
  return res.status === 204 ? {} : res.json();
}

async function pages(ref: BoardRef, path: string): Promise<any[]> {
  const out: any[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await call(ref, 'GET', `${path}${sep}per_page=${PAGE}&page=${page}`);
    if (!Array.isArray(batch)) throw new Unknown(`GitHub answered no list for ${path}`);
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
  throw new Unknown(`more than ${PAGE * MAX_PAGES} items at ${path}`);
}

const repo = (ref: BoardRef) => `/repos/${ref.project}`;
const labelsOf = (issue: any): string[] => (issue.labels ?? []).map((l: any) => l.name ?? l);

function factoryMarker(body: string): string | null {
  const m = new RegExp(`<!-- ${PLUGIN}:([a-z0-9-]+) -->`).exec(body ?? '');
  return m ? m[1] : null;
}

async function comments(ref: BoardRef, number: number): Promise<any[]> {
  return pages(ref, `${repo(ref)}/issues/${number}/comments`);
}

export const github: Board = {
  async list(ref, label) {
    const issues = await pages(
      ref,
      `${repo(ref)}/issues?state=open&labels=${encodeURIComponent(label)}`,
    );
    return issues
      .filter((i) => !i.pull_request)
      .map((i) => ({
        key: `${ref.project}#${i.number}`,
        number: i.number,
        url: i.html_url,
        labels: labelsOf(i),
      }));
  },

  async read(ref, number) {
    const issue = await call(ref, 'GET', `${repo(ref)}/issues/${number}`);
    if (!issue || issue.pull_request) return null;
    const raw = await comments(ref, number);
    const permission = new Map<string, string>();
    const logins = [issue.user?.login, ...raw.map((c) => c.user?.login)].filter(Boolean);
    for (const login of new Set(logins)) {
      const p = await call(ref, 'GET', `${repo(ref)}/collaborators/${login}/permission`);
      permission.set(login, p?.permission ?? 'none');
    }
    const view: TicketView = {
      key: `${ref.project}#${number}`,
      number,
      url: issue.html_url,
      title: issue.title ?? '',
      body: issue.body ?? '',
      author: {
        login: issue.user?.login ?? '',
        type: issue.user?.type ?? '',
        permission: permission.get(issue.user?.login) ?? 'none',
      },
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: labelsOf(issue),
      comments: raw.map((c): CommentView => ({
        id: c.id,
        author: c.user?.login ?? '',
        type: c.user?.type ?? '',
        permission: permission.get(c.user?.login) ?? 'none',
        body: c.body ?? '',
        factory: factoryMarker(c.body),
      })),
    };
    return view;
  },

  async comment(ref, number, name, body) {
    const text = `${body}\n\n${marker(name)}`;
    const existing = (await comments(ref, number)).find((c) =>
      String(c.body ?? '').includes(marker(name)),
    );
    if (existing) {
      await call(ref, 'PATCH', `${repo(ref)}/issues/comments/${existing.id}`, { body: text });
      return { id: existing.id };
    }
    const created = await call(ref, 'POST', `${repo(ref)}/issues/${number}/comments`, {
      body: text,
    });
    if (!created) throw new Error(`no issue ${ref.project}#${number}`);
    return { id: created.id };
  },

  async create(ref, name, ticket) {
    const existing = (
      await pages(
        ref,
        `${repo(ref)}/issues?state=all&labels=${encodeURIComponent(ticket.labels[0] ?? '')}`,
      )
    ).find((i) => !i.pull_request && String(i.body ?? '').includes(marker(name)));
    if (existing) return { number: existing.number, url: existing.html_url };
    const created = await call(ref, 'POST', `${repo(ref)}/issues`, {
      title: ticket.title,
      body: `${ticket.body}\n\n${marker(name)}`,
      labels: ticket.labels,
    });
    if (!created) throw new Error(`cannot create an issue in ${ref.project}`);
    return { number: created.number, url: created.html_url };
  },

  async labels(ref, number, add, remove) {
    if (add.length)
      await call(ref, 'POST', `${repo(ref)}/issues/${number}/labels`, { labels: add });
    for (const name of remove)
      await call(ref, 'DELETE', `${repo(ref)}/issues/${number}/labels/${encodeURIComponent(name)}`);
    const issue = await call(ref, 'GET', `${repo(ref)}/issues/${number}`);
    return issue ? labelsOf(issue) : [];
  },
};
