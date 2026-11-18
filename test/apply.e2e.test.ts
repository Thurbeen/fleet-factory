import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startGitHub, state } from './fake-github.ts';
import { FLEET } from './fleet-env.ts';

const FACTORY = resolve(import.meta.dirname, '../bin/factory.ts');
const TEMPLATE = resolve(import.meta.dirname, '../template/factory.json');
const STUB_REVIEWER = resolve(import.meta.dirname, 'stub-fleet-reviewer');

function edit(path: string, change: (v: any) => void) {
  const v = JSON.parse(readFileSync(path, 'utf8'));
  change(v);
  writeFileSync(path, JSON.stringify(v, null, 2));
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-factory-apply-'));
  const config = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  writeFileSync(join(dir, 'factory.json'), JSON.stringify(config, null, 2));
  const helper = join(dir, 'print-secret.sh');
  writeFileSync(helper, '#!/bin/sh\necho board-secret\n', { mode: 0o755 });
  writeFileSync(
    join(dir, 'factory.local.json'),
    JSON.stringify({
      fleetBin: FLEET,
      runtime: { kind: 'fake', dir: 'fake' },
      secrets: {
        'board-token': { command: [helper], as: 'GITHUB_TOKEN' },
        'reviewer-token': { command: ['/bin/echo', 'reviewer-secret'], as: 'REVIEWER_TOKEN' },
        'observability-token': { file: join(dir, 'obs.json') },
      },
    }),
  );
  return dir;
}

function factory(dir: string, ...args: string[]) {
  return factoryOn(process.env.PATH ?? '', dir, ...args);
}

function factoryOn(path: string, dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [FACTORY, ...args], {
    cwd: dir,
    env: { PATH: path, HOME: dir },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function fleet(dir: string, ...args: string[]) {
  return spawnSync(FLEET!, ['--config', join(dir, '.fleet/fleet.toml'), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir },
    encoding: 'utf8',
  });
}

describe.skipIf(!FLEET)('factory plan and apply against a real fleet', () => {
  it('plans without writing, applies once, then has nothing left to do', () => {
    const dir = workspace();
    const plan = factory(dir, 'plan');
    expect(plan.code, plan.err).toBe(0);
    expect(plan.out).toContain('create TicketSource/app');
    expect(plan.out).toContain('create TaskConfig/factory-build');
    expect(plan.out).toContain('create EnvProvider/secret-board-token');
    expect(existsSync(join(dir, '.fleet/fleet.toml'))).toBe(false);

    const apply = factory(dir, 'apply');
    expect(apply.code, apply.err).toBe(0);
    const toml = readFileSync(join(dir, '.fleet/fleet.toml'), 'utf8');
    expect(toml).toContain('[plugins.fleet-factory]');
    expect(toml).not.toContain('board-secret');
    const source = JSON.parse(fleet(dir, 'get', 'ticketsource', 'app').stdout);
    expect(source.spec.board).toMatchObject({ kind: 'github-issues', tokenEnv: 'GITHUB_TOKEN' });
    expect(source.metadata.labels['fleet-factory/managed']).toBe('acme');
    const provider = JSON.parse(fleet(dir, 'get', 'envprovider', 'secret-board-token').stdout);
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

  it('renders the reviewer login and filters into the ReviewSource', () => {
    const dir = workspace();
    edit(join(dir, 'factory.local.json'), (l) => (l.fleetReviewer = STUB_REVIEWER));
    edit(join(dir, 'factory.json'), (c) => {
      c.stages.review.login = 'review-app[bot]';
      c.stages.review.filters = { ownChanges: true, excludeLabels: ['wip'] };
    });
    const apply = factory(dir, 'apply');
    expect(apply.code, apply.err).toBe(0);
    const source = JSON.parse(fleet(dir, 'get', 'reviewsource', 'app').stdout);
    expect(source.spec.forge.login).toBe('review-app[bot]');
    expect(source.spec.filters).toEqual({
      requireLabels: ['factory'],
      ownChanges: true,
      excludeLabels: ['wip'],
    });
  });

  it('gives the reviewer plugin and the review session a fresh App token at each use', async () => {
    const api = await startGitHub();
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
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
        githubApp: { appId: '123', installationId: '456', keyFile, apiUrl: api },
        as: 'REVIEWER_TOKEN',
      };
    });
    edit(join(dir, 'factory.json'), (c) => {
      c.taskConfigs['factory-review'].secrets = ['reviewer-token'];
    });
    const apply = factoryOn(`${fakeBin}:${process.env.PATH}`, dir, 'apply');
    expect(apply.code, apply.err).toBe(0);

    const provider = JSON.parse(fleet(dir, 'get', 'envprovider', 'secret-reviewer-token').stdout);
    const [source] = provider.spec.sources;
    const resolveProvider = () =>
      JSON.parse(
        spawnSync(source.program, source.args, { cwd: source.cwd, encoding: 'utf8' }).stdout,
      );
    expect(resolveProvider()).toEqual({ REVIEWER_TOKEN: 'ghs_minted_1' });
    expect(resolveProvider()).toEqual({ REVIEWER_TOKEN: 'ghs_minted_2' });

    const review = JSON.parse(fleet(dir, 'get', 'taskconfig', 'factory-review').stdout);
    expect(review.spec.envFrom ?? []).not.toContainEqual({ name: 'secret-reviewer-token' });
    const sessionGh = () =>
      spawnSync('gh', ['pr', 'review', '--approve'], { env: review.spec.env, encoding: 'utf8' })
        .stdout;
    expect(sessionGh()).toBe('ghs_minted_3 pr review --approve\n');
    expect(sessionGh()).toBe('ghs_minted_4 pr review --approve\n');
    expect(JSON.stringify([provider, review])).not.toContain('PRIVATE KEY');
  });
});
