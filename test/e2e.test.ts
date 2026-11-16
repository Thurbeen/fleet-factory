import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Env, FLEET, PROJECT } from './fleet-env.ts';

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
