import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FLEET, makeDue } from './fleet-env.ts';

export const ROOT = resolve(import.meta.dirname, '..');
export const FACTORY = join(ROOT, 'bin/factory.ts');
export const TEMPLATE = join(ROOT, 'template/factory.json');
export const STUB_REVIEWER = join(ROOT, 'test/stub-fleet-reviewer');
export const USER_TOKEN = join(ROOT, 'test/fixtures/user-token');

export function edit(path: string, change: (v: any) => void) {
  const v = JSON.parse(readFileSync(path, 'utf8'));
  change(v);
  writeFileSync(path, JSON.stringify(v, null, 2));
}

export function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-factory-apply-'));
  writeFileSync(join(dir, 'factory.json'), readFileSync(join(USER_TOKEN, 'factory.json')));
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

export function appKeys() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

export const AUTHOR_APP = { appId: '111', installationId: '222' };
export const REVIEWER_APP = { appId: '333', installationId: '444' };

export function appWorkspace(api: string, privateKey: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-factory-app-'));
  const keyFile = join(dir, 'author.pem');
  writeFileSync(keyFile, privateKey, { mode: 0o600 });
  const fakeBin = join(dir, 'real-gh');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'gh'), '#!/bin/sh\necho "$GH_TOKEN $*"\n', { mode: 0o755 });
  const path = `${fakeBin}:${process.env.PATH}`;
  const config = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  config.repositories = [{ name: 'app', url: `${api}/OWNER/app`, branch: 'main' }];
  config.board.token = { secret: 'author-app' };
  config.forge.token = { secret: 'author-app' };
  config.stages.review.token = { secret: 'reviewer-app' };
  config.taskConfigs['factory-review'].secrets = ['reviewer-app'];
  for (const name of ['factory-refine', 'factory-build', 'factory-watch']) {
    const tc = config.taskConfigs[name];
    tc.env = { ...tc.env, PATH: path };
    tc.secrets = [...new Set(['author-app', ...(tc.secrets ?? [])])];
  }
  writeFileSync(join(dir, 'factory.json'), JSON.stringify(config, null, 2));
  writeFileSync(
    join(dir, 'factory.local.json'),
    JSON.stringify({
      fleetBin: FLEET,
      runtime: { kind: 'fake', dir: 'fake' },
      secrets: {
        'author-app': { githubApp: { ...AUTHOR_APP, keyFile, apiUrl: api }, as: 'GITHUB_TOKEN' },
        'reviewer-app': {
          githubApp: { ...REVIEWER_APP, keyFile, apiUrl: api },
          as: 'REVIEWER_TOKEN',
        },
        'observability-token': { file: join(dir, 'obs.json') },
      },
    }),
  );
  return { dir, path };
}

export function factory(dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [FACTORY, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

export function fleet(dir: string, ...args: string[]) {
  return spawnSync(FLEET!, ['--config', join(dir, '.fleet/fleet.toml'), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

export function sweep(dir: string, times = 1) {
  for (let i = 0; i < times; i++) {
    makeDue(join(dir, '.fleet/data'));
    const r = fleet(dir, 'reconcile');
    if (r.status !== 0) throw new Error(`fleet reconcile: ${r.status}\n${r.stdout}\n${r.stderr}`);
  }
}

export function get(dir: string, kind: string, name: string): any {
  const r = fleet(dir, 'get', kind, name);
  if (r.status !== 0) throw new Error(`fleet get ${kind} ${name}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
