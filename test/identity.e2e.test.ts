import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startGitHub, state } from './fake-github.ts';
import {
  AUTHOR_APP,
  ROOT,
  USER_TOKEN,
  appKeys,
  appWorkspace,
  edit,
  factory,
  fleet,
  get,
  sweep,
  workspace,
} from './factory-workspace.ts';
import { FLEET } from './fleet-env.ts';

const MINTED = /^ghs_minted_\d+$/;
const ISSUE = {
  number: 7,
  title: 'Export invoices as CSV',
  body: 'Customers want CSV.',
  state: 'open',
  labels: ['factory'],
  comments: [],
  user: { login: 'maintainer', type: 'User' },
};

function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
}

function gitRepos() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-factory-git-'));
  const bare = join(root, 'served', 'OWNER', 'app.git');
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const commit = ['-c', 'user.name=Worker', '-c', 'user.email=worker@example.com'];
  execFileSync('git', [...commit, 'commit', '-q', '--allow-empty', '-m', 'feat: one'], {
    cwd: work,
  });
  return { served: join(root, 'served'), bare, work, home: join(root, 'home') };
}

async function appFactory() {
  const api = await startGitHub();
  const keys = appKeys();
  const repos = gitRepos();
  await state(api, {
    token: 'user-token',
    app: {
      id: AUTHOR_APP.appId,
      installationId: AUTHOR_APP.installationId,
      publicKey: keys.publicKey,
    },
    issues: { 'OWNER/app#7': ISSUE },
    permissions: { maintainer: 'write' },
    gitRoot: repos.served,
  });
  const { dir, path } = appWorkspace(api, keys.privateKey);
  return { api, dir, path, repos };
}

function sessionEnv(dir: string, taskConfig: string, home: string): Record<string, string> {
  return { ...get(dir, 'taskconfig', `acme-${taskConfig}`).spec.env, HOME: home };
}

function list(dir: string, kind: string): any[] {
  const v = JSON.parse(fleet(dir, 'list', kind, '--json').stdout);
  return Array.isArray(v) ? v : v.items;
}

function record(dir: string, task: string, outputs: Record<string, unknown>) {
  const generation = String(get(dir, 'task', task).status.brief.generation);
  const args = ['result', task, '--generation', generation, '--outcome', 'shipped'];
  for (const [k, v] of Object.entries(outputs)) args.push('--output', `${k}=${JSON.stringify(v)}`);
  const r = fleet(dir, ...args);
  if (r.status !== 0) throw new Error(r.stderr);
}

const credentials = (requests: { credential: string }[]) => requests.map((r) => r.credential);

describe.skipIf(!FLEET)('every factory GitHub action runs as the author App', () => {
  it('a1: board, forge, gh and git push each carry a token minted for that use', async () => {
    const { api, dir, repos } = await appFactory();
    const apply = factory(dir, 'apply');
    expect(apply.code, apply.err).toBe(0);

    sweep(dir, 3);
    const refine = list(dir, 'task').find(
      (t) => t.metadata.labels?.['fleet-factory/stage'] === 'refine',
    );
    expect(refine, JSON.stringify(get(dir, 'ticketsource', 'app').status)).toBeDefined();
    record(dir, refine.metadata.name, {
      state: 'needs-decision',
      questions: [{ id: 'q1', text: 'Which columns?', area: 'scope' }],
    });
    sweep(dir, 2);

    let s = await state(api);
    const issue = s.issues['OWNER/app#7'];
    expect(issue.labels).toContain('factory:needs-decision');
    expect(issue.comments.map((c: any) => c.body).join()).toContain('Which columns?');
    const plugin = s.requests.filter((r: any) => !r.path.includes('.git/'));
    expect(plugin.some((r: any) => r.method === 'POST' && r.path.endsWith('/comments'))).toBe(true);
    expect(plugin.some((r: any) => r.path === '/repos/OWNER/app')).toBe(true);
    for (const c of credentials(plugin)) expect(c).toMatch(MINTED);
    expect(new Set(credentials(plugin)).size).toBeGreaterThan(1);

    const env = sessionEnv(dir, 'factory-build', repos.home);
    const gh = () => spawnSync('gh', ['pr', 'create', '--draft'], { env, encoding: 'utf8' });
    const first = gh();
    const second = gh();
    expect(first.stdout).toMatch(/^ghs_minted_\d+ pr create --draft\n$/);
    expect(second.stdout).toMatch(/^ghs_minted_\d+ pr create --draft\n$/);
    expect(first.stdout).not.toBe(second.stdout);
    expect(sessionEnv(dir, 'factory-refine', repos.home).GH_CONFIG_DIR).toBeDefined();

    s = await state(api);
    const before = s.minted;
    const pushed = git(repos.work, env, 'push', `${api}/OWNER/app.git`, 'main');
    expect(pushed.status, pushed.stderr).toBe(0);
    s = await state(api);
    expect(s.minted).toBe(before + 1);
    const pushes = credentials(s.requests.filter((r: any) => r.path.includes('.git/')));
    expect(pushes.filter(Boolean)).not.toHaveLength(0);
    for (const c of pushes.filter(Boolean)) expect(c).toMatch(MINTED);
    expect(credentials(s.requests)).not.toContain('user-token');
    expect(
      execFileSync('git', ['--git-dir', repos.bare, 'log', '--format=%s', 'main'], {
        encoding: 'utf8',
      }),
    ).toBe('feat: one\n');
  });

  it('a2: git push goes over HTTPS with a fresh App token past a host helper and an SSH remote', async () => {
    const { api, dir, repos } = await appFactory();
    const apply = factory(dir, 'apply');
    expect(apply.code, apply.err).toBe(0);

    const called = join(repos.home, 'host-login-used');
    mkdirSync(repos.home, { recursive: true });
    const hostHelper = join(repos.home, 'host-helper.sh');
    writeFileSync(
      hostHelper,
      `#!/bin/sh\ntouch '${called}'\nprintf 'username=operator\\npassword=user-token\\n'\n`,
      { mode: 0o755 },
    );
    const ssh = join(repos.home, 'ssh.sh');
    writeFileSync(ssh, `#!/bin/sh\ntouch '${called}'\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(repos.home, '.gitconfig'), `[credential]\n\thelper = ${hostHelper}\n`);
    const env = { ...sessionEnv(dir, 'factory-build', repos.home), GIT_SSH_COMMAND: ssh };

    for (const remote of ['ssh://git@127.0.0.1/OWNER/app.git', 'git@127.0.0.1:OWNER/app.git']) {
      const before = (await state(api)).minted;
      const pushed = git(repos.work, env, 'push', remote, `main:refs/heads/${before}`);
      expect(pushed.status, pushed.stderr).toBe(0);
      expect((await state(api)).minted).toBe(before + 1);
    }
    expect(existsSync(called)).toBe(false);

    await state(api, { requests: [] });
    const minted = (await state(api)).minted;
    const elsewhere = api.replace('127.0.0.1', 'localhost');
    const leaked = git(repos.work, env, 'ls-remote', `${elsewhere}/OWNER/app.git`);
    expect(leaked.status).not.toBe(0);
    expect(credentials((await state(api)).requests)).toEqual(['']);
    expect((await state(api)).minted).toBe(minted);
    expect(existsSync(called)).toBe(false);

    await state(api, { app: null, requests: [] });
    const failed = git(repos.work, env, 'push', 'ssh://git@127.0.0.1/OWNER/app.git', 'main:x');
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('github-app-token: HTTP 401');
    expect(existsSync(called)).toBe(false);
    expect(credentials((await state(api)).requests).filter(Boolean)).toEqual([]);
  });

  it('a6: a failed mint makes the sweep unknown and the session gh fail, naming github-app-token', async () => {
    const { api, dir, repos } = await appFactory();
    const apply = factory(dir, 'apply');
    expect(apply.code, apply.err).toBe(0);
    await state(api, { app: null, requests: [] });

    sweep(dir, 2);
    const source = get(dir, 'ticketsource', 'app');
    expect(source.status.unknown.why).toContain('github-app-token: HTTP 401');
    expect(credentials((await state(api)).requests)).toEqual([]);

    const gh = spawnSync('gh', ['pr', 'view'], {
      env: sessionEnv(dir, 'factory-build', repos.home),
      encoding: 'utf8',
    });
    expect(gh.status).not.toBe(0);
    expect(gh.stderr).toContain('github-app-token: HTTP 401');
    expect(gh.stdout).toBe('');
  });

  it("a8: Fleet's forge host runs gh through a wrapper that mints an author-App token per call", async () => {
    const { api, dir, path } = await appFactory();
    const apply = factory(dir, 'apply');
    expect(apply.code, apply.err).toBe(0);
    const host = new URL(api).host;
    const wrapper = join(dir, '.fleet/forge-gh');
    const toml = readFileSync(join(dir, '.fleet/fleet.toml'), 'utf8');
    expect(toml).toContain(`"${host}" = { kind = "github", cli = "${wrapper}" }`);
    const content = readFileSync(wrapper, 'utf8');
    expect(content).not.toMatch(/ghs_|PRIVATE KEY/);
    expect(statSync(wrapper).mode & 0o111).not.toBe(0);

    const call = () =>
      spawnSync(wrapper, ['api', 'user'], { env: { PATH: path }, encoding: 'utf8' });
    const first = call().stdout;
    const second = call().stdout;
    expect(first).toMatch(/^ghs_minted_\d+ api user\n$/);
    expect(second).toMatch(/^ghs_minted_\d+ api user\n$/);
    expect(first).not.toBe(second);

    const again = factory(dir, 'plan');
    expect(again.out).toContain('nothing to change');
  });

  it('a8: under fleetConfig, plan prints the forge host line and apply refuses until it is there', async () => {
    const { api, dir } = await appFactory();
    const host = new URL(api).host;
    const operator = join(dir, 'operator.toml');
    const plugin = [
      '[plugins.fleet-factory]',
      `program = "${process.execPath}"`,
      `args = ["${join(ROOT, 'src/plugin.ts')}"]`,
      `cwd = "${ROOT}"`,
      'tasks = "own"',
      'envFrom = [{ name = "acme-secret-author-app" }]',
    ].join('\n');
    const base = (hosts: string) =>
      [
        'version = 1',
        '[data]',
        'dir = "store"',
        '[runtime]',
        'kind = "fake"',
        'dir = "fake"',
        '[forge.hosts]',
        hosts,
        '',
        plugin,
        '',
      ].join('\n');
    writeFileSync(operator, base(`"${host}" = { kind = "github", cli = "gh" }`));
    edit(join(dir, 'factory.local.json'), (l) => (l.fleetConfig = operator));

    const plan = factory(dir, 'plan');
    expect(plan.code, plan.err).toBe(0);
    const wrapper = join(dir, '.fleet/forge-gh');
    const line = `"${host}" = { kind = "github", cli = "${wrapper}" }`;
    expect(plan.out).toContain(`differs [forge.hosts] "${host}" in ${operator}`);
    expect(plan.out).toContain(line);
    const refused = factory(dir, 'apply');
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('[forge.hosts]');

    writeFileSync(operator, base(''));
    expect(factory(dir, 'plan').out).toContain(`missing [forge.hosts] "${host}" in ${operator}`);

    writeFileSync(operator, base(line));
    const before = readFileSync(operator, 'utf8');
    const apply = factory(dir, 'apply');
    expect(apply.code, apply.err).toBe(0);
    expect(readFileSync(operator, 'utf8')).toBe(before);
    expect(existsSync(wrapper)).toBe(true);
    expect(factory(dir, 'plan').out).toContain('nothing to change');
  });
});

describe('a3: build and review run as different identities', () => {
  it('refuses the same secret, the same user-token source or the same file', () => {
    const cases: [string, (l: any) => void, string][] = [
      ['reviewer-token', () => {}, 'reviewer-token'],
      [
        'build-token',
        (l) =>
          (l.secrets['build-token'] = {
            command: ['/bin/echo', 'reviewer-secret'],
            as: 'GH_TOKEN',
          }),
        'build-token',
      ],
      [
        'build-file',
        (l) => {
          l.secrets['reviewer-token'] = { file: '/ABSOLUTE/PATH/token.json' };
          l.secrets['build-file'] = { file: '/ABSOLUTE/PATH/token.json' };
        },
        'build-file',
      ],
    ];
    for (const [secret, local, named] of cases) {
      const dir = workspace();
      edit(join(dir, 'factory.local.json'), local);
      edit(join(dir, 'factory.json'), (c) => (c.taskConfigs['factory-build'].secrets = [secret]));
      for (const command of ['plan', 'apply']) {
        const r = factory(dir, command);
        expect(r.code, `${secret} ${command}`).toBe(1);
        expect(r.err).toMatch(/^factory: /);
        expect(r.err).toContain(named);
        expect(r.err).toContain('reviewer-token');
      }
      expect(existsSync(join(dir, '.fleet'))).toBe(false);
    }
  });

  it('refuses one App on both sides, and plans two Apps or a user token beside an App', async () => {
    const keys = appKeys();
    const { dir } = appWorkspace('https://github.example.com/api/v3', keys.privateKey);
    const local = join(dir, 'factory.local.json');
    const reviewerApp = JSON.parse(readFileSync(local, 'utf8')).secrets['reviewer-app'];

    edit(local, (l) => {
      l.secrets['reviewer-app'].githubApp.appId = AUTHOR_APP.appId;
      l.secrets['reviewer-app'].githubApp.apiUrl = 'https://github.example.com/api/v3/';
    });
    const same = factory(dir, 'plan');
    expect(same.code).toBe(1);
    expect(same.err).toContain('author-app');
    expect(same.err).toContain('reviewer-app');

    edit(local, (l) => (l.secrets['reviewer-app'].githubApp.apiUrl = 'https://other.example.com'));
    expect(factory(dir, 'plan').code).toBe(0);

    edit(local, (l) => (l.secrets['reviewer-app'] = reviewerApp));
    expect(factory(dir, 'plan').code).toBe(0);

    edit(local, (l) => (l.secrets['reviewer-app'] = { command: ['/bin/echo', 'r'], as: 'R' }));
    expect(factory(dir, 'plan').code).toBe(0);
  });
});

describe.skipIf(!FLEET)('a5: an existing user-token config', () => {
  it('renders what main rendered, so a deployment from main has nothing to change', () => {
    const dir = workspace();
    const fill = (text: string) =>
      text
        .replaceAll('<FLEET>', FLEET!)
        .replaceAll('<DIR>', dir)
        .replaceAll('<ROOT>', ROOT)
        .replaceAll('<NODE>', process.execPath);
    writeFileSync(
      join(dir, 'factory.local.json'),
      fill(readFileSync(join(USER_TOKEN, 'factory.local.json'), 'utf8')),
    );
    mkdirSync(join(dir, '.fleet'));
    writeFileSync(
      join(dir, '.fleet/fleet.toml'),
      fill(readFileSync(join(USER_TOKEN, 'fleet.toml'), 'utf8')),
    );
    writeFileSync(
      join(dir, 'main.json'),
      fill(readFileSync(join(USER_TOKEN, 'objects.json'), 'utf8')),
    );
    const deployed = fleet(dir, 'apply', '-f', join(dir, 'main.json'));
    expect(deployed.status, deployed.stderr).toBe(0);

    const plan = factory(dir, 'plan');
    expect(plan.code, plan.err).toBe(0);
    expect(plan.out).toBe('nothing to change\n');
    expect(plan.err).toBe('');
  });
});

describe('a7: the template shows the two-App setup', () => {
  it('serves board, forge, refine, build and watch as the author App and review as another', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'template/factory.json'), 'utf8'));
    const local = JSON.parse(
      readFileSync(join(ROOT, 'template/factory.local.example.json'), 'utf8'),
    );
    expect(config.board.token).toEqual({ secret: 'author-app' });
    expect(config.forge.token).toEqual({ secret: 'author-app' });
    for (const name of ['factory-refine', 'factory-build', 'factory-watch'])
      expect(config.taskConfigs[name].secrets).toContain('author-app');
    expect(config.stages.review.token).toEqual({ secret: 'reviewer-app' });
    expect(local.secrets['author-app'].githubApp).toBeDefined();
    expect(local.secrets['author-app'].as).toBe('GITHUB_TOKEN');
    expect(local.secrets['reviewer-app'].githubApp).toBeDefined();
    expect(JSON.stringify(local)).not.toContain('"auth","token"');
    expect(JSON.stringify(local)).not.toMatch(/"auth",\s*"token"/);
  });
});
