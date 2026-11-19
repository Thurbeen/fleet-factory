import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const FLEET = process.env.FLEET_BIN;
const PLUGIN = resolve(import.meta.dirname, '../src/plugin.ts');
export const PROJECT = 'example/app';

if (!FLEET && process.env.FLEET_E2E_REQUIRED) {
  throw new Error('FLEET_E2E_REQUIRED is set but FLEET_BIN is not');
}

export type Comment = {
  id: number;
  author: string;
  permission: string;
  body: string;
  type?: string;
};
export type Author = { login: string; type: string; permission: string };
export type Ticket = {
  number: number;
  author?: Author;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: Comment[];
};

export function makeDue(dataDir: string) {
  for (const kind of ['TicketSource', 'Ticket', 'ChangeRequest']) {
    const dir = join(dataDir, 'objects', kind);
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      const obj = JSON.parse(readFileSync(path, 'utf8'));
      if (obj.status) obj.status.notBefore = 0;
      writeFileSync(path, JSON.stringify(obj));
    }
  }
}

export class Env {
  extraEnv: Record<string, string>;
  root = mkdtempSync(join(tmpdir(), 'fleet-factory-e2e-'));
  config = join(this.root, 'fleet.toml');
  board = join(this.root, 'board');

  constructor(extraEnv: Record<string, string> = {}) {
    this.extraEnv = extraEnv;
    mkdirSync(this.board);
    mkdirSync(join(this.root, 'forge'));
    writeFileSync(
      this.config,
      [
        'version = 1',
        '[data]',
        'dir = "data"',
        '[runtime]',
        'kind = "fake"',
        'dir = "fake"',
        '[forge]',
        'noCheckGraceMs = 1000',
        '[forge.hosts]',
        '"forge.test" = { kind = "fake", dir = "forge" }',
        '[forge.readyPolicies.checks]',
        'checksPassed = true',
        '[plugins.fleet-factory]',
        `program = '${process.execPath}'`,
        `args = ['${PLUGIN}']`,
        `cwd = '${this.root}'`,
        'callTimeoutMs = 10000',
        'tasks = "own"',
        `passEnv = ${JSON.stringify(['FLEET_FACTORY_FAKE_DIR', ...Object.keys(extraEnv)])}`,
        '',
      ].join('\n'),
    );
    this.writeBoard({ tickets: {}, nextComment: 1 });
    this.setGuardrails(GUARDED);
  }

  fleet(...args: string[]) {
    const r = spawnSync(FLEET!, ['--config', this.config, ...args], {
      cwd: this.root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: this.root,
        FLEET_FACTORY_FAKE_DIR: this.board,
        ...this.extraEnv,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
  }

  ok(...args: string[]): string {
    const r = this.fleet(...args);
    if (r.code !== 0) throw new Error(`fleet ${args.join(' ')}: ${r.code}\n${r.out}\n${r.err}`);
    return r.out;
  }

  apply(obj: object) {
    const path = join(this.root, 'apply.json');
    writeFileSync(path, JSON.stringify(obj));
    this.ok('apply', '-f', path);
  }

  get(kind: string, name: string): any {
    return JSON.parse(this.ok('get', kind, name));
  }

  list(kind: string): any[] {
    const v = JSON.parse(this.ok('list', kind, '--json'));
    return (Array.isArray(v) ? v : v.items).filter((o: any) => !o.metadata.deletionTimestamp);
  }

  sweep(times = 1) {
    for (let i = 0; i < times; i++) {
      makeDue(join(this.root, 'data'));
      this.ok('reconcile');
    }
  }

  rest() {
    const path = join(this.root, 'fake', 'state.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    for (const session of Object.values<any>(state.sessions ?? {})) session.atRest = true;
    writeFileSync(path, JSON.stringify(state));
  }

  backdateTicketStatus(field: string, ms: number) {
    const dir = join(this.root, 'data/objects', 'Ticket');
    for (const f of readdirSync(dir)) {
      const path = join(dir, f);
      const obj = JSON.parse(readFileSync(path, 'utf8'));
      obj.status[field] -= ms;
      writeFileSync(path, JSON.stringify(obj));
    }
  }

  backdateHeads(ms: number) {
    const dir = join(this.root, 'data/objects', 'ChangeRequest');
    for (const f of readdirSync(dir)) {
      const path = join(dir, f);
      const obj = JSON.parse(readFileSync(path, 'utf8'));
      obj.status.head.firstSeenAt -= ms;
      writeFileSync(path, JSON.stringify(obj));
    }
  }

  readBoard(): { tickets: Record<string, Ticket>; nextComment: number } {
    return JSON.parse(readFileSync(join(this.board, 'board.json'), 'utf8'));
  }

  writeBoard(v: object) {
    writeFileSync(join(this.board, 'board.json'), JSON.stringify(v, null, 2));
  }

  ticket(number: number): Ticket {
    return this.readBoard().tickets[`${PROJECT}#${number}`];
  }

  setTicket(t: Partial<Ticket> & { number: number }) {
    const b = this.readBoard();
    const key = `${PROJECT}#${t.number}`;
    const base: Ticket = b.tickets[key] ?? {
      number: t.number,
      title: '',
      body: '',
      state: 'open',
      labels: [],
      comments: [],
    };
    b.tickets[key] = { ...base, ...t };
    this.writeBoard(b);
  }

  comment(number: number, author: string, permission: string, body: string, type = 'User') {
    const b = this.readBoard();
    b.tickets[`${PROJECT}#${number}`].comments.push({
      id: b.nextComment++,
      author,
      permission,
      body,
      type,
    });
    this.writeBoard(b);
  }

  refineTask(): any {
    return this.list('task').find((t) => t.metadata.labels?.['fleet-factory/stage'] === 'refine');
  }

  result(task: string, outputs: Record<string, unknown>) {
    const generation = String(this.get('task', task).status.brief.generation);
    const args = ['result', task, '--generation', generation, '--outcome', 'shipped'];
    for (const [k, v] of Object.entries(outputs))
      args.push('--output', `${k}=${JSON.stringify(v)}`);
    this.ok(...args);
    this.ok('reconcile');
  }

  forgeState(): any {
    try {
      return JSON.parse(readFileSync(join(this.root, 'forge', 'state.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  setChange(id: number, change: object) {
    const s = this.forgeState();
    s.changes ??= {};
    s.changes[`${PROJECT}/${id}`] = {
      state: 'draft',
      head: { id: 'a'.repeat(40), checks: 'none' },
      reviewDecision: 'none',
      mergeable: { value: null, reason: null },
      threads: { unresolved: 0 },
      reviews: [],
      ...change,
    };
    writeFileSync(join(this.root, 'forge', 'state.json'), JSON.stringify(s, null, 2));
  }

  merges(): any[] {
    try {
      return JSON.parse(readFileSync(join(this.board, 'merges.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  stageTask(stage: string): any {
    return this.list('task').find((t) => t.metadata.labels?.['fleet-factory/stage'] === stage);
  }

  setGuardrails(v: object) {
    writeFileSync(join(this.board, 'guardrails.json'), JSON.stringify(v));
  }
}

export const GUARDED = {
  allowAutoMerge: true,
  rules: [
    {
      type: 'pull_request',
      parameters: { required_approving_review_count: 1, required_review_thread_resolution: true },
    },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI' }] } },
  ],
};
