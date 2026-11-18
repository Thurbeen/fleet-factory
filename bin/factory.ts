import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type J = any;
type GitHubApp = { appId: string; installationId: string; keyFile: string; apiUrl?: string };
type Secret = { command?: string[]; file?: string; githubApp?: GitHubApp; as?: string };

const ROOT = resolve(import.meta.dirname, '..');
const PLUGIN = join(ROOT, 'src/plugin.ts');
const SECRET_ENV = join(ROOT, 'bin/secret-env.ts');
const APP_TOKEN = join(ROOT, 'bin/github-app-token.ts');
const APP_GH_DIR = join(ROOT, 'bin/github-app-gh');
const APP_GIT_CREDENTIAL = join(ROOT, 'bin/git-credential-github-app');
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
    const sources = [s.command, s.file, s.githubApp].filter(Boolean).length;
    if (sources !== 1)
      throw new ConfigError(`secrets.${name}: give exactly one of command, file or githubApp`);
    if (s.githubApp) {
      const { appId, installationId, keyFile } = s.githubApp;
      if (!appId || !installationId || !String(keyFile ?? '').startsWith('/'))
        throw new ConfigError(
          `secrets.${name}.githubApp: give appId, installationId and an absolute keyFile`,
        );
      envName(name, secrets, `secrets.${name}`);
    }
    if (s.command && (!Array.isArray(s.command) || !String(s.command[0]).startsWith('/')))
      throw new ConfigError(`secrets.${name}.command: the program must be an absolute path`);
    if (s.file && !s.file.startsWith('/'))
      throw new ConfigError(`secrets.${name}.file: must be an absolute path`);
  }
}

type PluginEntry = {
  name: string;
  program: string;
  args: string[];
  cwd: string;
  envFrom: string[];
};

const tomlString = (s: string) => JSON.stringify(s);

function pluginToml(p: PluginEntry): string {
  return [
    `[plugins.${p.name}]`,
    `program = ${tomlString(p.program)}`,
    `args = [${p.args.map(tomlString).join(', ')}]`,
    `cwd = ${tomlString(p.cwd)}`,
    'tasks = "own"',
    `envFrom = [${p.envFrom.map((n) => `{ name = ${tomlString(n)} }`).join(', ')}]`,
  ].join('\n');
}

function tomlSection(toml: string, header: string): string | null {
  const lines = toml.split('\n');
  const bare = (line: string) => line.replace(/#.*$/, '').replace(/[\s"']/g, '');
  const start = lines.findIndex((l) => bare(l) === header);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trim().startsWith('['));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function tomlStrings(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) =>
    m[2] !== undefined ? m[2] : JSON.parse(`"${m[1]}"`),
  );
}

function tomlValue(section: string, key: string): string {
  const found = section.match(new RegExp(`^\\s*${key}\\s*=\\s*`, 'm'));
  if (!found) return '';
  const rest = section.slice(found.index! + found[0].length);
  if (!rest.startsWith('[')) return rest.split('\n')[0];
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    depth += rest[i] === '[' ? 1 : rest[i] === ']' ? -1 : 0;
    if (depth === 0) return rest.slice(0, i + 1);
  }
  return rest;
}

type Registration = 'present' | 'missing' | 'differs';

function registration(toml: string, p: PluginEntry): Registration {
  const section = tomlSection(toml, `[plugins.${p.name}]`);
  if (section === null) return 'missing';
  const [program] = tomlStrings(tomlValue(section, 'program'));
  const args = tomlStrings(tomlValue(section, 'args'));
  const envFrom = [
    ...tomlValue(section, 'envFrom').matchAll(/name\s*=\s*("[^"]*"|'[^']*')/g),
  ].flatMap((m) => tomlStrings(m[1]));
  const same =
    program === p.program &&
    JSON.stringify(args) === JSON.stringify(p.args) &&
    p.envFrom.every((n) => envFrom.includes(n));
  return same ? 'present' : 'differs';
}

function hostRegistration(toml: string, host: string, cli: string): Registration {
  const section = tomlSection(toml, '[forge.hosts]') ?? '';
  const line = section
    .split('\n')
    .find((l) => tomlStrings(l.split('=')[0])[0] === host || l.split('=')[0].trim() === host);
  if (!line) return 'missing';
  const [registered] = tomlStrings(/\bcli\s*=\s*("[^"]*"|'[^']*')/.exec(line)?.[1] ?? '');
  return registered === cli ? 'present' : 'differs';
}

const apiUrl = (app: GitHubApp) => (app.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');

function appTokenArgs(app: GitHubApp): string[] {
  return [
    APP_TOKEN,
    '--app-id',
    String(app.appId),
    '--installation-id',
    String(app.installationId),
    '--key-file',
    app.keyFile,
    '--api-url',
    apiUrl(app),
  ];
}

function appGitConfig(repositories: URL[]): [string, string][] {
  const perOrigin = repositories.flatMap((repo): [string, string][] => {
    const rewrite = `url.${repo.origin}/.insteadOf`;
    return [
      [`credential.${repo.origin}.helper`, APP_GIT_CREDENTIAL],
      [rewrite, `git@${repo.hostname}:`],
      [rewrite, `ssh://git@${repo.hostname}/`],
    ];
  });
  return [['credential.helper', ''], ...perOrigin];
}

function appSessionEnv(
  app: GitHubApp,
  path: string,
  dir: string,
  repositories: URL[],
): Record<string, string> {
  const git = appGitConfig(repositories);
  return {
    PATH: `${APP_GH_DIR}:${path}`,
    GH_CONFIG_DIR: join(dir, 'github-app-gh'),
    FACTORY_NODE: process.execPath,
    FACTORY_GITHUB_APP_ID: String(app.appId),
    FACTORY_GITHUB_INSTALLATION_ID: String(app.installationId),
    FACTORY_GITHUB_APP_KEY_FILE: app.keyFile,
    FACTORY_GITHUB_API_URL: apiUrl(app),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(git.length),
    ...Object.fromEntries(
      git.flatMap(([key, value], i) => [
        [`GIT_CONFIG_KEY_${i}`, key],
        [`GIT_CONFIG_VALUE_${i}`, value],
      ]),
    ),
  };
}

const shellWord = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function forgeGh(app: GitHubApp): string {
  return [
    '#!/bin/sh',
    'set -eu',
    `GH_TOKEN=$(${[process.execPath, ...appTokenArgs(app)].map(shellWord).join(' ')})`,
    'GH_ENTERPRISE_TOKEN=$GH_TOKEN',
    'export GH_TOKEN GH_ENTERPRISE_TOKEN',
    'exec gh "$@"',
    '',
  ].join('\n');
}

function sameSource(a: Secret, b: Secret): boolean {
  if (a.githubApp && b.githubApp)
    return (
      String(a.githubApp.appId) === String(b.githubApp.appId) &&
      apiUrl(a.githubApp) === apiUrl(b.githubApp)
    );
  if (a.command && b.command) return JSON.stringify(a.command) === JSON.stringify(b.command);
  return !!a.file && a.file === b.file;
}

function refuseOneIdentity(config: J, secrets: Record<string, Secret>) {
  const build = config.stages?.build;
  const reviewSecret = config.stages?.review?.token?.secret;
  if (!build || !secrets[reviewSecret]) return;
  for (const name of config.taskConfigs?.[build.taskConfig]?.secrets ?? []) {
    if (!secrets[name]) continue;
    if (name === reviewSecret || sameSource(secrets[name], secrets[reviewSecret]))
      throw new ConfigError(
        `the build secret ${name} and the review secret ${reviewSecret} are one identity; ` +
          'GitHub never counts an approval by the author of a change, so give the review its own App',
      );
  }
}

function appOf(config: J, secrets: Record<string, Secret>, taskConfig?: string) {
  const names: string[] = config.taskConfigs?.[taskConfig ?? '']?.secrets ?? [];
  return names.map((n) => secrets[n]?.githubApp).find(Boolean) ?? null;
}

function explicitApiUrl(secret: Secret) {
  return secret.githubApp?.apiUrl ? { apiUrl: apiUrl(secret.githubApp) } : {};
}

function render(config: J, local: J, dir: string, pluginCwd: string) {
  const secrets: Record<string, Secret> = local.secrets ?? {};
  const scoped = (name: string) => `${config.name}-${name}`;
  const provider = (secret: string) => scoped(`secret-${secret}`);
  validateSecrets(secrets);
  refuseOneIdentity(config, secrets);
  const repositories: URL[] = [
    ...new Map<string, URL>(
      (config.repositories ?? []).map((r: J) => [new URL(r.url).origin, new URL(r.url)]),
    ).values(),
  ];
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
    const apps = refs.filter((r: string) => secrets[r].githubApp);
    if (apps.length > 1)
      throw new ConfigError(`taskConfigs.${name}.secrets: name at most one githubApp secret`);
    const frozen = refs.filter((r: string) => !secrets[r].githubApp);
    for (const r of frozen) usedSecrets.add(r);
    const spec: J = { harness: tc.harness, host: tc.host };
    if (tc.model) spec.model = tc.model;
    const path = tc.env?.PATH ?? process.env.PATH ?? '';
    const env = {
      ...tc.env,
      ...(apps.length ? appSessionEnv(secrets[apps[0]].githubApp!, path, dir, repositories) : {}),
    };
    if (Object.keys(env).length) spec.env = env;
    if (frozen.length) spec.envFrom = frozen.map((r: string) => ({ name: provider(r) }));
    objects.push({ kind: 'TaskConfig', name: scoped(name), spec });
  }

  const review = config.stages?.review;
  let reviewerSecret: string | null = null;
  if (review && local.fleetReviewer) {
    reviewerSecret = secretRef(review.token, 'stages.review.token', secrets);
    usedSecrets.add(reviewerSecret);
  }

  for (const name of usedSecrets) {
    const s = secrets[name];
    const command = s.githubApp ? [process.execPath, ...appTokenArgs(s.githubApp)] : s.command!;
    const source = s.file
      ? { type: 'file', path: s.file }
      : {
          type: 'command',
          program: process.execPath,
          args: [
            SECRET_ENV,
            ...(s.githubApp ? ['--report-failure'] : []),
            envName(name, secrets, `secrets.${name}`),
            ...command,
          ],
          cwd: dir,
          timeoutMs: 10000,
        };
    objects.push({ kind: 'EnvProvider', name: provider(name), spec: { sources: [source] } });
  }

  for (const repo of config.repositories ?? []) {
    const stages: J = { refine: { taskConfig: scoped(config.stages.refine.taskConfig) } };
    if (config.stages.build)
      stages.build = {
        taskConfig: scoped(config.stages.build.taskConfig),
        ...(config.stages.build.readyPolicy
          ? { readyPolicy: config.stages.build.readyPolicy }
          : {}),
      };
    if (review?.login) stages.review = { approver: review.login };
    if (config.stages.watch)
      stages.watch = {
        ...config.stages.watch,
        taskConfig: scoped(config.stages.watch.taskConfig),
      };
    const spec: J = {
      board: {
        kind: config.board.kind,
        project: config.board.project,
        intakeLabel: config.board.intakeLabel ?? 'factory',
        tokenEnv: envName(boardSecret, secrets, 'board.token'),
        ...explicitApiUrl(secrets[boardSecret]),
      },
      repository: { url: repo.url, branch: repo.branch ?? 'main' },
      forge: {
        kind: config.forge.kind,
        tokenEnv: envName(forgeSecret, secrets, 'forge.token'),
        ...explicitApiUrl(secrets[forgeSecret]),
      },
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
            ...(secrets[reviewerSecret].githubApp ? { login: review.login } : {}),
          },
          repositories: [{ project }],
          filters: { requireLabels: [config.board.intakeLabel ?? 'factory'], ...review.filters },
          review: {
            taskConfig: scoped(review.taskConfig),
            ...(review.approveAt ? { approveAt: review.approveAt } : {}),
          },
        },
      });
    }
  }

  const plugins: PluginEntry[] = [
    {
      name: 'fleet-factory',
      program: process.execPath,
      args: [PLUGIN],
      cwd: pluginCwd,
      envFrom: [...new Set([boardSecret, forgeSecret])].map(provider),
    },
    ...(reviewerSecret
      ? [
          {
            name: 'fleet-reviewer',
            program: process.execPath,
            args: [join(local.fleetReviewer, 'src/plugin.ts')],
            cwd: local.fleetReviewer,
            envFrom: [provider(reviewerSecret)],
          },
        ]
      : []),
  ];

  const q = tomlString;
  const table = (o: J) =>
    Object.entries(o)
      .map(([k, v]) => `${k} = ${typeof v === 'string' ? q(v) : JSON.stringify(v)}`)
      .join('\n');
  const host = new URL(config.repositories?.[0]?.url ?? 'https://github.com').host;
  const authorApp = config.stages?.build
    ? appOf(config, secrets, config.stages.build.taskConfig)
    : null;
  const forgeCli = authorApp ? { path: join(dir, 'forge-gh'), content: forgeGh(authorApp) } : null;
  const forgeHost = `${q(host)} = { kind = "github", cli = ${q(forgeCli?.path ?? 'gh')} }`;
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
    forgeHost,
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
    ...plugins.flatMap((p) => ['', pluginToml(p)]),
    '',
  ].join('\n');

  return {
    toml,
    plugins,
    forge: { host, line: forgeHost, cli: forgeCli },
    objects: objects.map((o) => ({
      apiVersion: 'fleet/v1alpha1',
      kind: o.kind,
      metadata: { name: o.name, labels },
      spec: o.spec,
    })),
  };
}

function writeAtomically(path: string, content: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, content, { mode });
  renameSync(`${path}.tmp`, path);
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
  const operatorConfig = local.fleetConfig === undefined ? null : String(local.fleetConfig);
  if (operatorConfig !== null && !operatorConfig.startsWith('/'))
    throw new ConfigError('fleetConfig: must be an absolute path');
  const tomlPath = operatorConfig ?? join(dir, 'fleet.toml');

  if (command === 'up') {
    if (operatorConfig)
      throw new ConfigError(
        `fleetConfig names ${operatorConfig}, whose engine you run; factory up starts only a factory's own engine`,
      );
    const endpoint = config.observability?.fleetExport?.endpoint;
    const r = spawnSync(fleetBin, ['--config', tomlPath, 'up'], {
      stdio: 'inherit',
      env: { ...process.env, ...(endpoint ? { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint } : {}) },
    });
    return r.status ?? 1;
  }

  const { toml, plugins, forge, objects } = render(config, local, dir, operatorConfig ? ROOT : dir);
  const lines: string[] = [];
  const unregistered: string[] = [];
  let tomlChanged = false;
  if (operatorConfig) {
    if (!existsSync(operatorConfig))
      throw new ConfigError(`fleetConfig: ${operatorConfig} does not exist`);
    const operatorToml = readFileSync(operatorConfig, 'utf8');
    for (const p of plugins) {
      const state = registration(operatorToml, p);
      if (state === 'present') continue;
      unregistered.push(`[plugins.${p.name}]`);
      lines.push(`${state} [plugins.${p.name}] in ${operatorConfig}; it needs:\n${pluginToml(p)}`);
    }
    const host = forge.cli && hostRegistration(operatorToml, forge.host, forge.cli.path);
    if (host && host !== 'present') {
      unregistered.push(`[forge.hosts] "${forge.host}"`);
      lines.push(
        `${host} [forge.hosts] "${forge.host}" in ${operatorConfig}; it needs:\n[forge.hosts]\n${forge.line}`,
      );
    }
  } else {
    tomlChanged = !existsSync(tomlPath) || readFileSync(tomlPath, 'utf8') !== toml;
    if (tomlChanged) lines.push(`${existsSync(tomlPath) ? 'update' : 'create'} ${tomlPath}`);
  }
  const cliChanged =
    !!forge.cli &&
    (!existsSync(forge.cli.path) || readFileSync(forge.cli.path, 'utf8') !== forge.cli.content);
  if (forge.cli && cliChanged)
    lines.push(`${existsSync(forge.cli.path) ? 'update' : 'create'} ${forge.cli.path}`);
  const storeKnown = existsSync(tomlPath);

  const changed: J[] = [];
  for (const o of objects) {
    const id = `${o.kind}/${o.metadata.name}`;
    if (!storeKnown) {
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
  if (unregistered.length)
    throw new ConfigError(
      `add ${unregistered.join(' and ')} to ${operatorConfig} as plan prints them, then apply again`,
    );

  if (forge.cli && cliChanged) writeAtomically(forge.cli.path, forge.cli.content, 0o755);
  if (tomlChanged) writeAtomically(tomlPath, toml);
  if (changed.length) {
    mkdirSync(dir, { recursive: true });
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
