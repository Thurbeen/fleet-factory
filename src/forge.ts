import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Unknown } from './board/types.ts';
import { tokenFrom } from './util.ts';

export type ForgeRef = { kind: string; tokenEnv?: string; apiUrl?: string };
export type MergeRequest = { url: string; head: string; method: string };

function parse(url: string) {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) throw new Error(`not a pull request URL: ${url}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

async function fakeMerge(req: MergeRequest) {
  const dir = process.env.FLEET_FACTORY_FAKE_DIR;
  if (!dir) throw new Unknown('FLEET_FACTORY_FAKE_DIR is not set');
  const file = join(dir, 'merges.json');
  let merges: MergeRequest[] = [];
  try {
    merges = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    merges = [];
  }
  merges.push({ url: req.url, head: req.head, method: req.method });
  writeFileSync(file, JSON.stringify(merges));
  return { requested: true };
}

async function github(ref: ForgeRef, method: string, path: string, body?: unknown): Promise<any> {
  const token = tokenFrom(ref.tokenEnv);
  let res: Response;
  try {
    res = await fetch(`${(ref.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Unknown(`GitHub unreachable: ${(e as Error).message}`);
  }
  if (res.status >= 500) throw new Unknown(`GitHub answered ${res.status}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function githubMerge(ref: ForgeRef, req: MergeRequest) {
  const { owner, repo, number } = parse(req.url);
  const found = await github(ref, 'POST', '/graphql', {
    query:
      'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){id headRefOid}}}',
    variables: { o: owner, r: repo, n: number },
  });
  const pr = found.body?.data?.repository?.pullRequest;
  if (!pr) throw new Error(`pull request ${req.url} not found`);
  if (pr.headRefOid !== req.head) throw new Error(`head moved to ${pr.headRefOid}`);
  const enabled = await github(ref, 'POST', '/graphql', {
    query:
      'mutation($id:ID!,$h:GitObjectID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH,expectedHeadOid:$h}){clientMutationId}}',
    variables: { id: pr.id, h: req.head },
  });
  const errors: string = (enabled.body?.errors ?? []).map((e: any) => e.message).join('; ');
  if (!errors) return { autoMerge: true };
  if (!/clean status/i.test(errors)) throw new Error(errors);
  const merged = await github(ref, 'PUT', `/repos/${owner}/${repo}/pulls/${number}/merge`, {
    sha: req.head,
    merge_method: 'squash',
  });
  if (merged.status !== 200)
    throw new Error(`merge refused: ${merged.body?.message ?? merged.status}`);
  return { merged: true };
}

export async function autoMerge(ref: ForgeRef, req: MergeRequest) {
  if (ref.kind === 'fake') return fakeMerge(req);
  if (ref.kind === 'github') return githubMerge(ref, req);
  throw new Error(`no forge adapter ${ref.kind}`);
}

export type Guardrails = { allowAutoMerge: boolean; rules: { type: string; parameters?: any }[] };

function repoOf(url: string) {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/#]+?)(\.git)?\/?$/.exec(url);
  if (!m) throw new Error(`not a repository URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}

export async function guardrails(ref: ForgeRef, url: string, branch: string): Promise<Guardrails> {
  if (ref.kind === 'fake') {
    const dir = process.env.FLEET_FACTORY_FAKE_DIR;
    if (!dir) throw new Unknown('FLEET_FACTORY_FAKE_DIR is not set');
    try {
      return JSON.parse(readFileSync(join(dir, 'guardrails.json'), 'utf8'));
    } catch {
      throw new Unknown('fake guardrails unreadable');
    }
  }
  if (ref.kind !== 'github') throw new Error(`no forge adapter ${ref.kind}`);
  const { owner, repo } = repoOf(url);
  const meta = await github(ref, 'GET', `/repos/${owner}/${repo}`);
  const rules = await github(
    ref,
    'GET',
    `/repos/${owner}/${repo}/rules/branches/${encodeURIComponent(branch)}`,
  );
  if (meta.status !== 200 || rules.status !== 200 || !Array.isArray(rules.body))
    throw new Unknown(`GitHub answered ${meta.status}/${rules.status} for the branch rules`);
  return { allowAutoMerge: !!meta.body.allow_auto_merge, rules: rules.body };
}

export function missingGuardrails(g: Guardrails): string[] {
  const missing: string[] = [];
  const pr = g.rules.filter((r) => r.type === 'pull_request').map((r) => r.parameters ?? {});
  const checks = g.rules
    .filter((r) => r.type === 'required_status_checks')
    .flatMap((r) => r.parameters?.required_status_checks ?? []);
  if (!pr.some((p) => Number(p.required_approving_review_count ?? 0) >= 1))
    missing.push('a required approval');
  if (!pr.some((p) => p.required_review_thread_resolution === true))
    missing.push('required thread resolution');
  if (!checks.length) missing.push('required status checks');
  if (!g.allowAutoMerge) missing.push('auto-merge allowed');
  return missing;
}

export type Release = { tag: string; url: string; publishedAt: number };

export async function release(ref: ForgeRef, change: string): Promise<Release | null> {
  if (ref.kind === 'fake') {
    const dir = process.env.FLEET_FACTORY_FAKE_DIR;
    if (!dir) throw new Unknown('FLEET_FACTORY_FAKE_DIR is not set');
    let all: (Release & { changes: string[] })[] = [];
    try {
      all = JSON.parse(readFileSync(join(dir, 'releases.json'), 'utf8'));
    } catch {
      return null;
    }
    const found = all
      .filter((r) => r.changes.includes(change))
      .sort((a, b) => a.publishedAt - b.publishedAt)[0];
    return found ? { tag: found.tag, url: found.url, publishedAt: found.publishedAt } : null;
  }
  if (ref.kind !== 'github') throw new Error(`no forge adapter ${ref.kind}`);
  const { owner, repo, number } = parse(change);
  const pr = await github(ref, 'GET', `/repos/${owner}/${repo}/pulls/${number}`);
  if (pr.status !== 200) throw new Unknown(`GitHub answered ${pr.status} for ${change}`);
  const sha = pr.body.merge_commit_sha;
  const mergedAt = Date.parse(pr.body.merged_at ?? '');
  if (!sha || !mergedAt) return null;
  const releases = await github(ref, 'GET', `/repos/${owner}/${repo}/releases?per_page=30`);
  if (releases.status !== 200 || !Array.isArray(releases.body))
    throw new Unknown(`GitHub answered ${releases.status} for the releases`);
  const candidates = releases.body
    .filter((r: any) => !r.draft && !r.prerelease && Date.parse(r.published_at) >= mergedAt)
    .sort((a: any, b: any) => Date.parse(a.published_at) - Date.parse(b.published_at));
  for (const r of candidates) {
    const cmp = await github(
      ref,
      'GET',
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(r.tag_name)}...${sha}`,
    );
    if (cmp.status === 200 && ['behind', 'identical'].includes(cmp.body.status))
      return { tag: r.tag_name, url: r.html_url, publishedAt: Date.parse(r.published_at) };
  }
  return null;
}
