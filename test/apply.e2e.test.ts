import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLEET } from './fleet-env.ts';

const FACTORY = resolve(import.meta.dirname, '../bin/factory.ts');
const TEMPLATE = resolve(import.meta.dirname, '../template/factory.json');

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
  const r = spawnSync(process.execPath, [FACTORY, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir },
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
});
