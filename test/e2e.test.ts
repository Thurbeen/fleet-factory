import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FLEET = process.env.FLEET_BIN;
const PLUGIN = resolve(import.meta.dirname, '../src/plugin.ts');
const PROJECT = 'example/app';

if (!FLEET && process.env.FLEET_E2E_REQUIRED) {
  throw new Error('FLEET_E2E_REQUIRED is set but FLEET_BIN is not');
}

type Comment = { id: number; author: string; permission: string; body: string };
type Ticket = {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: Comment[];
};

class Env {
  root = mkdtempSync(join(tmpdir(), 'fleet-factory-e2e-'));
  config = join(this.root, 'fleet.toml');
  board = join(this.root, 'board');

  constructor() {
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
        "passEnv = ['FLEET_FACTORY_FAKE_DIR']",
        '',
      ].join('\n'),
    );
    this.writeBoard({ tickets: {}, nextComment: 1 });
  }

  fleet(...args: string[]) {
    const r = spawnSync(FLEET!, ['--config', this.config, ...args], {
      cwd: this.root,
      env: { PATH: process.env.PATH ?? '', HOME: this.root, FLEET_FACTORY_FAKE_DIR: this.board },
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

function setup(): Env {
  const env = new Env();
  env.setTicket({
    number: 1,
    title: 'Export invoices as CSV',
    body: 'Customers want their invoices as CSV.',
    labels: ['factory'],
  });
  env.setTicket({ number: 2, title: 'Not for the factory', labels: [] });
  env.apply({
    apiVersion: 'fleet/v1alpha1',
    kind: 'TaskConfig',
    metadata: { name: 'factory-refine' },
    spec: { harness: 'claude-code' },
  });
  env.apply({
    apiVersion: 'fleet/v1alpha1',
    kind: 'TicketSource',
    metadata: { name: 'app' },
    spec: {
      board: { kind: 'fake', project: PROJECT },
      repository: { url: 'https://forge.test/example/app', branch: 'main' },
      stages: { refine: { taskConfig: 'factory-refine' } },
    },
  });
  env.sweep(3);
  return env;
}

const QUESTION = { id: 'q1', text: 'Which columns does the CSV hold?', area: 'scope' };

describe.skipIf(!FLEET)('fleet-factory against a real fleet', () => {
  it('starts one refine Task for a ticket labelled factory, and none for others', () => {
    const env = setup();
    const tickets = env.list('ticket');
    expect(tickets.map((t) => t.spec.key)).toEqual([`${PROJECT}#1`]);
    const task = env.refineTask();
    expect(task.metadata.labels['fleet.dev/plugin']).toBe('fleet-factory');
    expect(task.spec.configRef).toEqual({ name: 'factory-refine' });
    expect(task.spec.workspace).toEqual(['git+https://forge.test/example/app#main']);
    expect(task.spec.dispatch).toBe(true);
    expect(task.spec.brief).toContain('Export invoices as CSV');
    expect(task.spec.brief).toContain('Customers want their invoices as CSV.');
    expect(task.spec.outputs.state).toEqual({ type: 'string', required: true });

    env.sweep(2);
    expect(env.list('task')).toHaveLength(1);
    expect(env.list('ticket')).toHaveLength(1);
  });

  it('asks a question on the ticket, relays a collaborator answer, then records decisions', () => {
    const env = setup();
    const name = env.refineTask().metadata.name;
    env.result(name, { state: 'needs-decision', decisions: [], questions: [QUESTION] });
    env.sweep(2);

    let ticket = env.ticket(1);
    const asked = ticket.comments.filter((c) =>
      c.body.includes('<!-- fleet-factory:refinement -->'),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0].body).toContain('Which columns does the CSV hold?');
    expect(ticket.labels).toContain('factory:needs-decision');
    expect(env.list('ticket')[0].status.phase).toBe('NeedsDecision');

    env.comment(1, 'drive-by', 'read', 'Put everything in it.');
    env.comment(1, 'maintainer', 'write', 'Date, number, total.');
    env.sweep(2);
    const amended = env.get('task', name);
    expect(amended.spec.amendments).toHaveLength(1);
    expect(amended.spec.amendments[0].from).toBe('plugin/fleet-factory');
    expect(amended.spec.amendments[0].text).toContain('Date, number, total.');
    expect(amended.spec.amendments[0].text).not.toContain('Put everything in it.');

    env.sweep(2);
    expect(env.get('task', name).spec.amendments).toHaveLength(1);

    env.result(name, {
      state: 'refined',
      decisions: [
        { id: 'd1', text: 'Columns: date, number, total.', area: 'scope', by: 'maintainer' },
      ],
      acceptance: [
        {
          id: 'a1',
          text: 'An invoice exports as CSV.',
          signal: 'csv_exports_total',
          slo: '99% succeed',
        },
      ],
      questions: [],
    });
    env.sweep(2);
    ticket = env.ticket(1);
    const refined = ticket.comments.filter((c) =>
      c.body.includes('<!-- fleet-factory:refinement -->'),
    );
    expect(refined).toHaveLength(1);
    expect(refined[0].id).toBe(asked[0].id);
    expect(refined[0].body).toContain('Columns: date, number, total.');
    expect(refined[0].body).toContain('csv_exports_total');
    expect(ticket.labels).toContain('factory:refined');
    expect(ticket.labels).not.toContain('factory:needs-decision');
    expect(env.list('ticket')[0].status.phase).toBe('Refined');
  });

  it('drops the ticket and its Task when the factory label is removed', () => {
    const env = setup();
    env.setTicket({ number: 1, labels: [] });
    env.sweep(3);
    expect(env.list('ticket')[0]?.status.phase ?? 'Dropped').toBe('Dropped');
    expect(env.refineTask()).toBeUndefined();
  });
});

if (FLEET) console.log(execFileSync(FLEET, ['version'], { encoding: 'utf8' }).split('\n')[0]);
