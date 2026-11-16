import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type J = any;
type Secret = { command?: string[]; file?: string; as?: string };

const ROOT = resolve(import.meta.dirname, '..');
const PLUGIN = join(ROOT, 'src/plugin.ts');
const SECRET_ENV = join(ROOT, 'bin/secret-env.ts');
const MANAGED = 'fleet-factory/managed';

class ConfigError extends Error {}

function read(path: string): J {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`);
  }
}

function secretRef(value: unknown, path: string, secrets: Record<string, Secret>): string {
  if (!value || typeof value !== 'object' || typeof (value as J).secret !== 'string')
    throw new ConfigError(`${path}: expected a secret reference {"secret": NAME}, not a value`);
  const name = (value as J).secret;
  if (!secrets[name])
    throw new ConfigError(`${path}: secret ${name} has no source in factory.local.json`);
  return name;
}

function envName(name: string, secrets: Record<string, Secret>, path: string): string {
  const as = secrets[name]?.as;
  if (!as) throw new ConfigError(`${path}: secret ${name} needs "as", the variable it sets`);
  return as;
}

function validateSecrets(secrets: Record<string, Secret>) {
  for (const [name, s] of Object.entries(secrets)) {
    const sources = [s.command, s.file].filter(Boolean).length;
    if (sources !== 1)
      throw new ConfigError(`secrets.${name}: give exactly one of command or file`);
    if (s.command && (!Array.isArray(s.command) || !String(s.command[0]).startsWith('/')))
      throw new ConfigError(`secrets.${name}.command: the program must be an absolute path`);
    if (s.file && !s.file.startsWith('/'))
      throw new ConfigError(`secrets.${name}.file: must be an absolute path`);
  }
}

const provider = (name: string) => `secret-${name}`;

function render(config: J, local: J, dir: string) {
  const secrets: Record<string, Secret> = local.secrets ?? {};
  validateSecrets(secrets);
  const labels = { [MANAGED]: String(config.name) };
  const boardSecret = secretRef(config.board?.token, 'board.token', secrets);
  const forgeSecret = secretRef(config.forge?.token, 'forge.token', secrets);
  const objects: J[] = [];

  const usedSecrets = new Set<string>([boardSecret, forgeSecret]);
  const taskConfigs: Record<string, J> = config.taskConfigs ?? {};
  for (const [name, tc] of Object.entries(taskConfigs)) {
    const refs = (tc.secrets ?? []).map((s: string, i: number) =>
      secretRef({ secret: s }, `taskConfigs.${name}.secrets[${i}]`, secrets),
    );
    for (const r of refs) usedSecrets.add(r);
    const spec: J = { harness: tc.harness, host: tc.host };
    if (tc.model) spec.model = tc.model;
    if (tc.env) spec.env = tc.env;
    if (refs.length) spec.envFrom = refs.map((r: string) => ({ name: provider(r) }));
    objects.push({ kind: 'TaskConfig', name, spec });
  }

  const review = config.stages?.review;
  let reviewerSecret: string | null = null;
  if (review && local.fleetReviewer) {
    reviewerSecret = secretRef(review.token, 'stages.review.token', secrets);
    usedSecrets.add(reviewerSecret);
  }

  for (const name of usedSecrets) {
    const s = secrets[name];
    const source = s.file
      ? { type: 'file', path: s.file }
      : {
          type: 'command',
          program: process.execPath,
          args: [SECRET_ENV, envName(name, secrets, `secrets.${name}`), ...s.command!],
          cwd: dir,
          timeoutMs: 10000,
        };
    objects.push({ kind: 'EnvProvider', name: provider(name), spec: { sources: [source] } });
  }

  for (const repo of config.repositories ?? []) {
    const stages: J = { refine: { taskConfig: config.stages.refine.taskConfig } };
    if (config.stages.build)
      stages.build = {
        taskConfig: config.stages.build.taskConfig,
        ...(config.stages.build.readyPolicy
          ? { readyPolicy: config.stages.build.readyPolicy }
          : {}),
      };
    if (review?.login) stages.review = { approver: review.login };
    if (config.stages.watch) stages.watch = { ...config.stages.watch };
    const spec: J = {
      board: {
        kind: config.board.kind,
        project: config.board.project,
        intakeLabel: config.board.intakeLabel ?? 'factory',
        tokenEnv: envName(boardSecret, secrets, 'board.token'),
      },
      repository: { url: repo.url, branch: repo.branch ?? 'main' },
      forge: { kind: config.forge.kind, tokenEnv: envName(forgeSecret, secrets, 'forge.token') },
      stages,
    };
    if (config.policy) spec.policy = config.policy;
    if (config.merge) spec.merge = config.merge;
    objects.push({ kind: 'TicketSource', name: repo.name, spec });

    if (reviewerSecret) {
      const project = new URL(repo.url).pathname.replace(/^\/|\.git$/g, '');
      objects.push({
        kind: 'ReviewSource',
        name: repo.name,
        spec: {
          forge: {
            kind: 'github',
            host: new URL(repo.url).host,
            tokenEnv: envName(reviewerSecret, secrets, 'stages.review.token'),
          },
          repositories: [{ project }],
          filters: { requireLabels: [config.board.intakeLabel ?? 'factory'] },
          review: {
            taskConfig: review.taskConfig,
            ...(review.approveAt ? { approveAt: review.approveAt } : {}),
          },
        },
      });
    }
  }

  const q = (s: string) => JSON.stringify(s);
  const table = (o: J) =>
    Object.entries(o)
      .map(([k, v]) => `${k} = ${typeof v === 'string' ? q(v) : JSON.stringify(v)}`)
      .join('\n');
  const envFrom = (names: string[]) =>
    `[${names.map((n) => `{ name = ${q(provider(n))} }`).join(', ')}]`;
  const host = new URL(config.repositories?.[0]?.url ?? 'https://github.com').host;
  const toml = [
    'version = 1',
    '',
    '[data]',
    'dir = "data"',
    '',
    '[runtime]',
    table(local.runtime ?? {}),
    '',
    '[forge]',
    '',
    '[forge.hosts]',
    `${q(host)} = { kind = "github", cli = "gh" }`,
    '',
    '[forge.readyPolicies.checks]',
    'checksPassed = true',
    '',
    '[forge.readyPolicies.checks-and-bots]',
    'botReviewsAddressed = true',
    'checksPassed = true',
    '',
    '[forge.readyPolicies.strict]',
    'botReviewsAddressed = true',
    'checksPassed = true',
    'noUnresolvedThreads = true',
    '',
    '[plugins.fleet-factory]',
    `program = ${q(process.execPath)}`,
    `args = [${q(PLUGIN)}]`,
    `cwd = ${q(dir)}`,
    'tasks = "own"',
    `envFrom = ${envFrom([...new Set([boardSecret, forgeSecret])])}`,
    ...(reviewerSecret
      ? [
          '',
          '[plugins.fleet-reviewer]',
          `program = ${q(process.execPath)}`,
          `args = [${q(join(local.fleetReviewer, 'src/plugin.ts'))}]`,
          `cwd = ${q(local.fleetReviewer)}`,
          'tasks = "own"',
          `envFrom = ${envFrom([reviewerSecret])}`,
        ]
      : []),
    '',
  ].join('\n');

  return {
    toml,
    objects: objects.map((o) => ({
      apiVersion: 'fleet/v1alpha1',
      kind: o.kind,
      metadata: { name: o.name, labels },
      spec: o.spec,
    })),
  };
}

function fleet(fleetBin: string, config: string, ...args: string[]) {
  return spawnSync(fleetBin, ['--config', config, ...args], { encoding: 'utf8' });
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
}

function main(argv: string[]): number {
  const command = argv[0];
  if (!['plan', 'apply', 'up'].includes(command ?? '')) {
    process.stderr.write('usage: factory.ts plan|apply|up\n');
    return 2;
  }
  const cwd = process.cwd();
  const config = read(join(cwd, 'factory.json'));
  const local = read(join(cwd, 'factory.local.json'));
  const fleetBin = String(local.fleetBin ?? 'fleet');
  const dir = join(cwd, '.fleet');
  const tomlPath = join(dir, 'fleet.toml');

  if (command === 'up') {
    const endpoint = config.observability?.fleetExport?.endpoint;
    const r = spawnSync(fleetBin, ['--config', tomlPath, 'up'], {
      stdio: 'inherit',
      env: { ...process.env, ...(endpoint ? { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint } : {}) },
    });
    return r.status ?? 1;
  }

  const { toml, objects } = render(config, local, dir);
  const lines: string[] = [];
  const tomlChanged = !existsSync(tomlPath) || readFileSync(tomlPath, 'utf8') !== toml;
  if (tomlChanged) lines.push(`${existsSync(tomlPath) ? 'update' : 'create'} ${tomlPath}`);

  const changed: J[] = [];
  for (const o of objects) {
    const id = `${o.kind}/${o.metadata.name}`;
    if (!existsSync(tomlPath)) {
      lines.push(`create ${id}`);
      changed.push(o);
      continue;
    }
    const got = fleet(fleetBin, tomlPath, 'get', o.kind.toLowerCase(), o.metadata.name);
    if (got.status !== 0) {
      lines.push(`create ${id}`);
      changed.push(o);
      continue;
    }
    const live = JSON.parse(got.stdout);
    const same =
      canonical(live.spec) === canonical(o.spec) &&
      live.metadata?.labels?.[MANAGED] === o.metadata.labels[MANAGED];
    if (!same) {
      lines.push(`update ${id}`);
      changed.push(o);
    }
  }

  if (!lines.length) {
    process.stdout.write('nothing to change\n');
    return 0;
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (command === 'plan') return 0;

  if (tomlChanged) {
    mkdirSync(dirname(tomlPath), { recursive: true });
    writeFileSync(`${tomlPath}.tmp`, toml);
    renameSync(`${tomlPath}.tmp`, tomlPath);
  }
  if (changed.length) {
    const file = join(dir, 'apply.json');
    writeFileSync(file, JSON.stringify({ items: changed }));
    const r = fleet(fleetBin, tomlPath, 'apply', '-f', file);
    process.stdout.write(r.stdout);
    if (r.status !== 0) {
      process.stderr.write(r.stderr);
      return r.status ?? 1;
    }
  }
  process.stdout.write('applied\n');
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  process.stderr.write(`factory: ${e.message}\n`);
  process.exitCode = 1;
}
