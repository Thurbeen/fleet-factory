import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Unknown } from './board/types.ts';

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

async function github(ref: ForgeRef, method: string, path: string, body: unknown): Promise<any> {
  const token = process.env[ref.tokenEnv ?? 'GITHUB_TOKEN'];
  if (!token) throw new Unknown(`${ref.tokenEnv ?? 'GITHUB_TOKEN'} is not set`);
  let res: Response;
  try {
    res = await fetch(`${(ref.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
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
