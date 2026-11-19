import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startGitHubWithGit, state } from './fake-github.ts';
import { Env, FLEET, PROJECT } from './fleet-env.ts';
import { CHANGE, GUARDED, HEAD, approve, phase } from './flows.ts';

const FACTORY = resolve(import.meta.dirname, '../bin/factory.ts');
const TEMPLATE = resolve(import.meta.dirname, '../template/factory.json');
const USER_TOKEN = 'user-token';
const AUTHOR_APP = { id: '111', installationId: '222' };
const PROVIDER = 'acme-secret-author-token';

type Logged = { method: string; path: string; authorization: string | null; accepted: boolean };

function keyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function tokenOf(authorization: string | null): string | null {
  const m = /^(?:Bearer|token) (.+)$/.exec(authorization ?? '');
  if (m) return m[1];
  const basic = /^Basic (.+)$/.exec(authorization ?? '');
  if (!basic) return null;
  const decoded = Buffer.from(basic[1], 'base64').toString();
  return decoded.slice(decoded.indexOf(':') + 1);
}

function run(program: string, args: string[], options: object) {
  const r = spawnSync(program, args, { encoding: 'utf8', timeout: 120_000, ...options });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function realGhStub(dir: string): string {
  const bin = join(dir, 'real-gh');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gh'),
    [
      `#!${process.execPath}`,
      `const [cmd, sub, op] = process.argv.slice(2);`,
      `const token = process.env.GH_TOKEN;`,
      `if (!token) { process.stderr.write('gh: not logged in\\n'); process.exit(4); }`,
      `if (cmd === 'auth' && sub === 'git-credential') {`,
      `  if (op !== 'get') process.exit(0);`,
      `  const host = /host=(.*)/.exec(require('node:fs').readFileSync(0, 'utf8'))[1];`,
      `  process.stdout.write('protocol=https\\nhost=' + host + '\\nusername=x-access-token\\npassword=' + token + '\\n');`,
      `  process.exit(0);`,
      `}`,
      `const create = cmd === 'pr' && sub === 'create';`,
      `fetch(process.env.STUB_GH_API + (create ? '/repos/${PROJECT}/pulls' : '/repos/${PROJECT}/pulls/11'), {`,
      `  method: create ? 'POST' : 'GET',`,
      `  headers: { authorization: 'token ' + token, 'content-type': 'application/json' },`,
      `  body: create ? JSON.stringify({ title: 'feat: export invoices' }) : undefined,`,
      `}).then(async (r) => {`,
      `  if (!r.ok) { process.stderr.write('gh: HTTP ' + r.status + '\\n'); process.exit(1); }`,
      `  process.stdout.write(await r.text());`,
      `});`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

async function factoryOnFleet() {
  const { api, git, ca } = await startGitHubWithGit();
  const dir = mkdtempSync(join(tmpdir(), 'fleet-factory-identity-'));
  const author = keyPair();
  const reviewer = keyPair();
  const authorKey = join(dir, 'author.pem');
  const reviewerKey = join(dir, 'reviewer.pem');
  writeFileSync(authorKey, author.privateKey, { mode: 0o600 });
  writeFileSync(reviewerKey, reviewer.privateKey, { mode: 0o600 });

  const gitRoot = join(dir, 'git');
  mkdirSync(join(gitRoot, 'example'), { recursive: true });
  run('git', ['init', '-q', '--bare', join(gitRoot, `${PROJECT}.git`)], {});
  const app = { ...AUTHOR_APP, publicKey: author.publicKey };
  await state(api, {
    token: USER_TOKEN,
    app,
    gitRoot,
    guardrails: GUARDED,
    pulls: { [`${PROJECT}#11`]: { head: HEAD } },
    permissions: { maintainer: 'write' },
    issues: {
      [`${PROJECT}#1`]: {
        number: 1,
        title: 'Export invoices as CSV',
        body: 'Customers want CSV.',
        state: 'open',
        labels: ['factory'],
        user: { login: 'maintainer', type: 'User' },
        comments: [],
      },
    },
  });

  const env = new Env({}, [PROVIDER]);
  const stub = realGhStub(dir);
  const config = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  config.board.project = PROJECT;
  config.board.token = { secret: 'author-token' };
  config.forge.token = { secret: 'author-token' };
  config.repositories = [{ name: 'app', url: `${git}/${PROJECT}`, branch: 'main' }];
  for (const name of ['factory-refine', 'factory-build'])
    config.taskConfigs[name] = {
      harness: 'claude-code',
      secrets: ['author-token'],
      env: { PATH: `${stub}:${process.env.PATH}` },
    };
  for (const name of ['factory-review', 'factory-watch'])
    config.taskConfigs[name] = { harness: 'claude-code' };
  config.stages.review.login = 'reviewer-bot';
  writeFileSync(join(dir, 'factory.json'), JSON.stringify(config, null, 2));
  writeFileSync(
    join(dir, 'factory.local.json'),
    JSON.stringify({
      fleetBin: FLEET,
      fleetConfig: env.config,
      secrets: {
        'author-token': {
          githubApp: {
            appId: AUTHOR_APP.id,
            installationId: AUTHOR_APP.installationId,
            keyFile: authorKey,
            apiUrl: api,
          },
          as: 'GITHUB_TOKEN',
        },
        'reviewer-token': {
          githubApp: { appId: '999', installationId: '998', keyFile: reviewerKey, apiUrl: api },
          as: 'REVIEWER_TOKEN',
        },
      },
    }),
  );
  const applied = run(process.execPath, [FACTORY, 'apply'], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir },
  });
  expect(applied.code, applied.out + applied.err).toBe(0);

  const source = env.get('ticketsource', 'app');
  env.apply({
    apiVersion: source.apiVersion,
    kind: source.kind,
    metadata: { name: 'app', labels: source.metadata.labels },
    spec: {
      ...source.spec,
      board: { ...source.spec.board, apiUrl: api },
      forge: { ...source.spec.forge, apiUrl: api },
    },
  });

  const host = join(dir, 'host-home');
  mkdirSync(host);
  const userHelper = `!f() { echo username=operator; echo password=${USER_TOKEN}; }; f`;
  writeFileSync(
    join(host, '.gitconfig'),
    [
      '[user]',
      '  name = Operator',
      '  email = operator@example.com',
      '[credential]',
      `  helper = "${userHelper}"`,
      `[credential "${git}"]`,
      `  helper = "${userHelper}"`,
      '',
    ].join('\n'),
  );
  const work = join(dir, 'work');
  run('git', ['init', '-q', '-b', 'main', work], { env: { ...process.env, HOME: host } });

  const session = (taskConfig: string, program: string, args: string[]) => {
    const tc = env.get('taskconfig', `acme-${taskConfig}`);
    return run(program, args, {
      cwd: work,
      env: {
        ...tc.spec.env,
        HOME: host,
        GH_TOKEN: USER_TOKEN,
        STUB_GH_API: api,
        GIT_SSL_CAINFO: ca,
      },
    });
  };
  const commit = (n: number) => {
    writeFileSync(join(work, 'export.txt'), `version ${n}\n`);
    run('git', ['add', '.'], { cwd: work, env: { ...process.env, HOME: host } });
    run('git', ['commit', '-qm', `feat: export ${n}`], {
      cwd: work,
      env: { ...process.env, HOME: host },
    });
  };
  const push = (n: number) => {
    commit(n);
    return session('factory-build', 'git', [
      'push',
      `${git}/${PROJECT}.git`,
      `HEAD:refs/heads/feat-${n}`,
    ]);
  };
  const requests = async (): Promise<Logged[]> => (await state(api)).requests;
  return { env, api, app, dir, session, push, requests };
}

async function tokensDuring(requests: () => Promise<Logged[]>, act: () => unknown) {
  const before = (await requests()).length;
  await act();
  const during = (await requests()).slice(before).filter((r) => !r.path.startsWith('/app/'));
  return new Set(during.map((r) => tokenOf(r.authorization)).filter(Boolean));
}

const disjoint = (a: Set<unknown>, b: Set<unknown>) => [...a].every((x) => !b.has(x));
const isBoard = (r: Logged) => /\/(issues|collaborators)/.test(r.path);
const isForge = (r: Logged) =>
  r.path === '/graphql' || /^\/repos\/[^/]+\/[^/]+(\/rules\/.*)?$/.test(r.path);
const isGh = (r: Logged) => /\/pulls/.test(r.path);
const isGit = (r: Logged) => /\.git\//.test(r.path);

describe.skipIf(!FLEET)('every factory GitHub action runs as the author App', () => {
  it('signs each board, forge, gh and git push request with a fresh installation token', async () => {
    const f = await factoryOnFleet();
    const { env, requests } = f;

    const sweeps: Set<unknown>[] = [];
    for (let i = 0; i < 3; i++) sweeps.push(await tokensDuring(requests, () => env.sweep(1)));
    const refine = env.stageTask('refine');
    expect(refine).toBeDefined();
    env.result(refine.metadata.name, {
      state: 'refined',
      decisions: [{ id: 'd1', text: 'Columns: date, total.', area: 'scope', by: 'maintainer' }],
      acceptance: [{ id: 'a1', text: 'Exports as CSV.', signal: 'csv_exports_total', slo: '99%' }],
      questions: [],
    });
    sweeps.push(await tokensDuring(requests, () => env.sweep(2)));
    const issues = (await state(f.api)).issues;
    expect(issues[`${PROJECT}#1`].labels).toContain('factory:refined');
    issues[`${PROJECT}#1`].labels.push('factory:ready');
    await state(f.api, { issues });
    sweeps.push(await tokensDuring(requests, () => env.sweep(2)));
    const build = env.stageTask('build');
    expect(build).toBeDefined();

    const gh = [
      await tokensDuring(requests, () => {
        const r = f.session('factory-build', 'gh', ['pr', 'create', '--draft']);
        expect(r.code, r.err).toBe(0);
      }),
      await tokensDuring(requests, () => {
        const r = f.session('factory-build', 'gh', ['pr', 'view', '11']);
        expect(r.code, r.err).toBe(0);
      }),
    ];
    const pushes = [
      await tokensDuring(requests, () => {
        const r = f.push(1);
        expect(r.code, r.err).toBe(0);
      }),
      await tokensDuring(requests, () => {
        const r = f.push(2);
        expect(r.code, r.err).toBe(0);
      }),
    ];

    env.setChange(11, { state: 'draft', head: { id: HEAD, checks: 'pending' } });
    env.ok('declare', build.metadata.name, '--change-request', CHANGE);
    env.sweep(2);
    sweeps.push(await tokensDuring(requests, () => approve(env)));
    expect(phase(env)).toBe('Merging');

    const s = await state(f.api);
    expect(s.autoMerges).toEqual([{ id: `PR_${PROJECT}#11`, head: HEAD }]);
    expect(s.created).toEqual([{ project: PROJECT, title: 'feat: export invoices' }]);
    const signed: Logged[] = s.requests.filter((r: Logged) => !r.path.startsWith('/app/'));
    expect(signed.filter((r) => tokenOf(r.authorization) === USER_TOKEN)).toEqual([]);
    for (const [kind, of] of [
      ['board', isBoard],
      ['forge', isForge],
      ['gh', isGh],
      ['git', isGit],
    ] as const) {
      const mine = signed.filter(of).filter((r) => r.authorization);
      expect(mine.length, kind).toBeGreaterThan(0);
      for (const r of mine) {
        expect(tokenOf(r.authorization), `${kind} ${r.method} ${r.path}`).toMatch(
          /^ghs_minted_\d+$/,
        );
        expect(r.accepted, `${kind} ${r.method} ${r.path}`).toBe(true);
      }
    }
    expect(signed.filter((r) => !isGit(r) && !r.authorization)).toEqual([]);

    const swept = sweeps.filter((t) => t.size);
    expect(swept.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < swept.length; i++)
      for (let j = i + 1; j < swept.length; j++) expect(disjoint(swept[i], swept[j])).toBe(true);
    expect(gh.map((t) => t.size)).toEqual([1, 1]);
    expect(disjoint(gh[0], gh[1])).toBe(true);
    expect(pushes.every((t) => t.size >= 1)).toBe(true);
    expect(disjoint(pushes[0], pushes[1])).toBe(true);

    const configs = JSON.stringify(env.list('taskconfig'));
    expect(configs).not.toMatch(/ghs_|user-token|PRIVATE KEY/);
    for (const tc of env.list('taskconfig'))
      expect(tc.spec.envFrom ?? [], tc.metadata.name).not.toContainEqual({ name: PROVIDER });
  });

  it('fails gh and git push in the session, with no fallback to the host login, when minting fails', async () => {
    const f = await factoryOnFleet();
    await state(f.api, { app: { ...f.app, installationId: 'revoked' } });

    const gh = f.session('factory-build', 'gh', ['pr', 'create', '--draft']);
    expect(gh.code).not.toBe(0);
    expect(gh.err).toContain('github-app-token: HTTP 401');

    const pushed = f.push(1);
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain('github-app-token: HTTP 401');

    const s = await state(f.api);
    const fallback = s.requests.filter((r: Logged) => tokenOf(r.authorization) === USER_TOKEN);
    expect(fallback).toEqual([]);
    expect(s.created).toEqual([]);
  });
});
