import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startGitHub, state } from './fake-github.ts';
import {
  ROOT,
  STUB_REVIEWER,
  appKeys,
  edit,
  factory,
  fleet,
  workspace,
} from './factory-workspace.ts';
import { FLEET } from './fleet-env.ts';

const PLUGIN = join(ROOT, 'src/plugin.ts');

function operatorFleet(root: string) {
  const config = join(root, 'fleet.toml');
  writeFileSync(
    config,
    [
      'version = 1',
      '[data]',
      'dir = "store"',
      '[runtime]',
      'kind = "fake"',
      'dir = "fake"',
      '[forge.hosts]',
      '"github.com" = { kind = "github", cli = "gh" }',
      '',
    ].join('\n'),
  );
  return config;
}

function operatorPlugins(root: string, factories: string[]) {
  const envFrom = (secret: string) =>
    `[${factories.map((f) => `{ name = "${f}-secret-${secret}" }`).join(', ')}]`;
  return [
    '[plugins.fleet-factory]',
    `program = "${process.execPath}"`,
    `args = ["${PLUGIN}"]`,
    `cwd = "${root}"`,
    'tasks = "own"',
    `envFrom = ${envFrom('board-token')}`,
    '',
    '[plugins."fleet-reviewer"]',
    `program = "${process.execPath}"`,
    `args = ["${join(STUB_REVIEWER, 'src/plugin.ts')}"]`,
    `cwd = "${STUB_REVIEWER}"`,
    'callTimeoutMs = 15000',
    'tasks = "own"',
    'envFrom = [',
    '  { name = "operator-tokens" },',
    ...factories.map((f) => `  { name = "${f}-secret-reviewer-token" },`),
    ']',
    '',
  ].join('\n');
}

describe.skipIf(!FLEET)('factories on an operator-owned Fleet config', () => {
  it('apply into it without writing it, and two factories share one store', () => {
    const shared = mkdtempSync(join(tmpdir(), 'fleet-factory-shared-'));
    const operator = operatorFleet(shared);
    const factories = { acme: workspace(), beta: workspace() };
    for (const [name, dir] of Object.entries(factories)) {
      edit(join(dir, 'factory.local.json'), (l) => {
        l.fleetConfig = operator;
        l.fleetReviewer = STUB_REVIEWER;
      });
      edit(join(dir, 'factory.json'), (c) => {
        c.name = name;
        c.repositories = [{ name: `${name}-app`, url: `https://github.com/OWNER/${name}` }];
      });
    }
    const onOperator = (...args: string[]) =>
      spawnSync(FLEET!, ['--config', operator, ...args], { cwd: shared, encoding: 'utf8' });
    const before = readFileSync(operator, 'utf8');

    const plan = factory(factories.acme, 'plan');
    expect(plan.code, plan.err).toBe(0);
    expect(plan.out).toContain(`missing [plugins.fleet-factory] in ${operator}`);
    expect(plan.out).toContain('envFrom = [{ name = "acme-secret-board-token" }]');
    expect(plan.out).toContain('create TaskConfig/acme-factory-build');
    expect(plan.out).toContain('create EnvProvider/acme-secret-board-token');
    expect(plan.out).toContain('create TicketSource/acme-app');

    const refused = factory(factories.acme, 'apply');
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain(operator);
    expect(readFileSync(operator, 'utf8')).toBe(before);
    expect(existsSync(join(factories.acme, '.fleet/fleet.toml'))).toBe(false);

    writeFileSync(operator, `${before}\n${operatorPlugins(shared, ['acme', 'beta'])}`);
    const withPlugins = readFileSync(operator, 'utf8');
    for (const dir of Object.values(factories)) {
      const apply = factory(dir, 'apply');
      expect(apply.code, apply.err).toBe(0);
    }
    expect(readFileSync(operator, 'utf8')).toBe(withPlugins);
    expect(existsSync(join(factories.acme, '.fleet/fleet.toml'))).toBe(false);

    for (const name of Object.keys(factories)) {
      const review = JSON.parse(onOperator('get', 'taskconfig', `${name}-factory-review`).stdout);
      expect(review.metadata.labels['fleet-factory/managed']).toBe(name);
      const source = JSON.parse(onOperator('get', 'ticketsource', `${name}-app`).stdout);
      expect(source.spec.stages.refine.taskConfig).toBe(`${name}-factory-refine`);
      const reviewSource = JSON.parse(onOperator('get', 'reviewsource', `${name}-app`).stdout);
      expect(reviewSource.spec.review.taskConfig).toBe(`${name}-factory-review`);
    }
    for (const dir of Object.values(factories)) {
      const again = factory(dir, 'plan');
      expect(again.code, again.err).toBe(0);
      expect(again.out).toContain('nothing to change');
    }

    const up = factory(factories.acme, 'up');
    expect(up.code).not.toBe(0);
    expect(up.err).toContain('fleetConfig');
  });
});

describe.skipIf(!FLEET)('factory plan and apply against a real fleet', () => {
  it('plans without writing, applies once, then has nothing left to do', () => {
    const dir = workspace();
    const plan = factory(dir, 'plan');
    expect(plan.code, plan.err).toBe(0);
    expect(plan.out).toContain('create TicketSource/app');
    expect(plan.out).toContain('create TaskConfig/acme-factory-build');
    expect(plan.out).toContain('create EnvProvider/acme-secret-board-token');
    expect(existsSync(join(dir, '.fleet/fleet.toml'))).toBe(false);

    const apply = factory(dir, 'apply');
    expect(apply.code, apply.err).toBe(0);
    const toml = readFileSync(join(dir, '.fleet/fleet.toml'), 'utf8');
    expect(toml).toContain('[plugins.fleet-factory]');
    expect(toml).not.toContain('board-secret');
    const source = JSON.parse(fleet(dir, 'get', 'ticketsource', 'app').stdout);
    expect(source.spec.board).toMatchObject({ kind: 'github-issues', tokenEnv: 'GITHUB_TOKEN' });
    expect(source.metadata.labels['fleet-factory/managed']).toBe('acme');
    const provider = JSON.parse(fleet(dir, 'get', 'envprovider', 'acme-secret-board-token').stdout);
    expect(JSON.stringify(provider)).not.toContain('board-secret');

    const again = factory(dir, 'plan');
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain('nothing to change');
  });

  it('refuses a secret written as a value', () => {
    const dir = workspace();
    const config = JSON.parse(readFileSync(join(dir, 'factory.json'), 'utf8'));
    config.board.token = 'ghp_literal';
    writeFileSync(join(dir, 'factory.json'), JSON.stringify(config));
    const r = factory(dir, 'plan');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('board.token');
    expect(r.err).toContain('secret reference');
  });

  it('renders the reviewer filters, and no login for a personal token', () => {
    const dir = workspace();
    edit(join(dir, 'factory.local.json'), (l) => (l.fleetReviewer = STUB_REVIEWER));
    edit(join(dir, 'factory.json'), (c) => {
      c.stages.review.login = 'review-app[bot]';
      c.stages.review.filters = { ownChanges: true, excludeLabels: ['wip'] };
    });
    const apply = factory(dir, 'apply');
    expect(apply.code, apply.err).toBe(0);
    const source = JSON.parse(fleet(dir, 'get', 'reviewsource', 'app').stdout);
    expect(source.spec.forge.login).toBeUndefined();
    expect(source.spec.filters).toEqual({
      requireLabels: ['factory'],
      ownChanges: true,
      excludeLabels: ['wip'],
    });
  });

  it('gives the reviewer plugin and the review session a fresh App token at each use', async () => {
    const api = await startGitHub();
    const keys = appKeys();
    await state(api, { app: { id: '123', installationId: '456', publicKey: keys.publicKey } });
    const dir = workspace();
    const keyFile = join(dir, 'app.pem');
    writeFileSync(keyFile, keys.privateKey, { mode: 0o600 });
    const fakeBin = join(dir, 'real-gh');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'gh'), '#!/bin/sh\necho "$GH_TOKEN $*"\n', { mode: 0o755 });
    edit(join(dir, 'factory.local.json'), (l) => {
      l.fleetReviewer = STUB_REVIEWER;
      l.secrets['reviewer-token'] = {
        githubApp: { appId: '123', installationId: '456', keyFile, apiUrl: `${api}/` },
        as: 'REVIEWER_TOKEN',
      };
    });
    edit(join(dir, 'factory.json'), (c) => {
      c.taskConfigs['factory-review'].secrets = ['reviewer-token'];
      c.taskConfigs['factory-review'].env = { PATH: `${fakeBin}:${process.env.PATH}` };
    });
    const apply = factory(dir, 'apply');
    expect(apply.code, apply.err).toBe(0);

    const provider = JSON.parse(
      fleet(dir, 'get', 'envprovider', 'acme-secret-reviewer-token').stdout,
    );
    const [source] = provider.spec.sources;
    const resolveProvider = () =>
      JSON.parse(
        spawnSync(source.program, source.args, { cwd: source.cwd, encoding: 'utf8' }).stdout,
      );
    expect(resolveProvider()).toEqual({ REVIEWER_TOKEN: 'ghs_minted_1' });
    expect(resolveProvider()).toEqual({ REVIEWER_TOKEN: 'ghs_minted_2' });

    const reviewSource = JSON.parse(fleet(dir, 'get', 'reviewsource', 'app').stdout);
    expect(reviewSource.spec.forge.login).toBe('REVIEWER_LOGIN');

    const review = JSON.parse(fleet(dir, 'get', 'taskconfig', 'acme-factory-review').stdout);
    expect(review.spec.env.GH_CONFIG_DIR).toBe(join(dir, '.fleet/github-app-gh'));
    expect(review.spec.envFrom ?? []).not.toContainEqual({ name: 'acme-secret-reviewer-token' });
    const sessionGh = () =>
      spawnSync('gh', ['pr', 'review', '--approve'], { env: review.spec.env, encoding: 'utf8' })
        .stdout;
    expect(sessionGh()).toBe('ghs_minted_3 pr review --approve\n');
    expect(sessionGh()).toBe('ghs_minted_4 pr review --approve\n');
    expect(JSON.stringify([provider, review])).not.toContain('PRIVATE KEY');
  });
});
