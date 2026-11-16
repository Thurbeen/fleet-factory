import { describe, expect, it } from 'vitest';
import { Env, FLEET, GUARDED, PROJECT } from './fleet-env.ts';

const HEAD = 'b'.repeat(40);
const CHANGE = 'https://forge.test/example/app/pull/11';

function refined(): Env {
  const env = new Env();
  env.setTicket({
    number: 1,
    title: 'Export invoices as CSV',
    body: 'Customers want CSV.',
    labels: ['factory'],
  });
  for (const name of ['factory-refine', 'factory-build'])
    env.apply({
      apiVersion: 'fleet/v1alpha1',
      kind: 'TaskConfig',
      metadata: { name },
      spec: { harness: 'claude-code' },
    });
  env.apply({
    apiVersion: 'fleet/v1alpha1',
    kind: 'TicketSource',
    metadata: { name: 'app' },
    spec: {
      board: { kind: 'fake', project: PROJECT },
      repository: { url: 'https://forge.test/example/app', branch: 'main' },
      forge: { kind: 'fake' },
      stages: {
        refine: { taskConfig: 'factory-refine' },
        build: { taskConfig: 'factory-build', readyPolicy: 'checks' },
        review: { approver: 'reviewer-bot' },
      },
    },
  });
  env.sweep(3);
  env.result(env.stageTask('refine').metadata.name, {
    state: 'refined',
    decisions: [{ id: 'd1', text: 'Columns: date, total.', area: 'scope', by: 'maintainer' }],
    acceptance: [{ id: 'a1', text: 'Exports as CSV.', signal: 'csv_exports_total', slo: '99%' }],
    questions: [],
  });
  env.sweep(2);
  return env;
}

function building(): { env: Env; build: any } {
  const env = refined();
  env.setTicket({ number: 1, labels: ['factory', 'factory:refined', 'factory:ready'] });
  env.sweep(2);
  const build = env.stageTask('build');
  env.setChange(11, { state: 'draft', head: { id: HEAD, checks: 'pending' } });
  env.ok('declare', build.metadata.name, '--change-request', CHANGE);
  env.sweep(2);
  return { env, build };
}

function approve(env: Env, extra: object = {}) {
  env.setChange(11, {
    state: 'open',
    head: { id: HEAD, checks: 'passed' },
    reviews: [{ id: 'r1', author: 'reviewer-bot', state: 'approved', head: HEAD }],
    ...extra,
  });
  env.sweep(3);
}

const phase = (env: Env) => env.list('ticket')[0].status.phase;

describe.skipIf(!FLEET)('build and merge through a real fleet', () => {
  it('waits for factory:ready before it starts a build', () => {
    const env = refined();
    env.sweep(2);
    expect(phase(env)).toBe('Refined');
    expect(env.stageTask('build')).toBeUndefined();
  });

  it('starts no build where the branch rules allow an unreviewed merge', () => {
    const env = refined();
    env.setGuardrails({ ...GUARDED, rules: GUARDED.rules.slice(1) });
    env.setTicket({ number: 1, labels: ['factory', 'factory:refined', 'factory:ready'] });
    env.sweep(3);
    expect(env.stageTask('build')).toBeUndefined();
    const guarded = env
      .get('ticketsource', 'app')
      .status.conditions.find((c: any) => c.type === 'Guarded');
    expect(guarded).toMatchObject({ status: 'False', reason: 'Missing' });
    expect(guarded.message).toContain('approval');

    env.setGuardrails(GUARDED);
    env.sweep(3);
    expect(env.stageTask('build')).toBeDefined();
  });

  it('starts a test-first build Task that opens a draft and follows the ready policy', () => {
    const { env, build } = building();
    expect(build.spec.configRef).toEqual({ name: 'factory-build' });
    expect(build.spec.forge).toEqual({ draft: { policy: 'checks' } });
    expect(build.spec.outputs.changeUrl).toEqual({ type: 'string', required: true });
    expect(build.spec.brief).toContain('Columns: date, total.');
    expect(build.spec.brief).toContain('csv_exports_total');
    expect(build.spec.brief).toContain('failing end-to-end test');
    expect(build.spec.brief).toContain('--draft');
    expect(phase(env)).toBe('Building');
  });

  it('requests a squash auto-merge once the approver approved the head and checks passed', () => {
    const { env } = building();
    approve(env, { threads: { unresolved: 1 } });
    expect(env.merges()).toHaveLength(0);
    expect(phase(env)).toBe('InReview');

    approve(env);
    expect(env.merges()).toEqual([{ url: CHANGE, head: HEAD, method: 'squash' }]);
    expect(phase(env)).toBe('Merging');
    env.sweep(2);
    expect(env.merges()).toHaveLength(1);

    env.setChange(11, { state: 'merged', head: { id: HEAD, checks: 'passed' } });
    env.sweep(3);
    expect(phase(env)).toBe('Merged');
    expect(env.list('ticket')[0].status.change).toMatchObject({ url: CHANGE, head: HEAD });
  });

  it('never merges while the ticket holds factory:hold, or on an approval of another head', () => {
    const { env } = building();
    env.setTicket({ number: 1, labels: ['factory', 'factory:ready', 'factory:hold'] });
    approve(env);
    expect(env.merges()).toHaveLength(0);

    env.setTicket({ number: 1, labels: ['factory', 'factory:ready'] });
    approve(env, {
      reviews: [{ id: 'r1', author: 'reviewer-bot', state: 'approved', head: 'c'.repeat(40) }],
    });
    expect(env.merges()).toHaveLength(0);
    expect(phase(env)).toBe('InReview');
  });
});
