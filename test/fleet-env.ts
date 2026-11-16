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

export type Comment = { id: number; author: string; permission: string; body: string };
export type Ticket = {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: Comment[];
};

export class Env {
  extraEnv: Record<string, string>;
  root = mkdtempSync(join(tmpdir(), 'fleet-factory-e2e-'));
  config = join(this.root, 'fleet.toml');
  board = join(this.root, 'board');

  constructor(extraEnv: Record<string, string> = {}) {
    this.extraEnv = extraEnv;
    mkdirSync(this.board);
    writeFileSync(
      this.config,
      [
        'version = 1',
        '[data]',
        'dir = "data"',
        '[runtime]',
        'kind = "fake"',
        'dir = "fake"',
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
      for (const kind of ['TicketSource', 'Ticket']) {
        const dir = join(this.root, 'data/objects', kind);
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
      this.ok('reconcile');
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

  comment(number: number, author: string, permission: string, body: string) {
    const b = this.readBoard();
    b.tickets[`${PROJECT}#${number}`].comments.push({
      id: b.nextComment++,
      author,
      permission,
      body,
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
}
