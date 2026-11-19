import { describe, expect, it } from 'vitest';
import { type Env, FLEET, PROJECT } from './fleet-env.ts';
import { CHANGE, GUARDED, HEAD, approve, building, phase, refined } from './flows.ts';

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

  it('briefs a re-created build Task onto the change its ticket already has', () => {
    const { env, build } = building();
    env.setChange(11, { state: 'open', head: { id: HEAD, checks: 'passed' } });
    env.sweep(2);
    env.result(build.metadata.name, { changeUrl: CHANGE });
    env.rest();
    env.ok('delete', 'task', build.metadata.name);
    env.sweep(4);

    const rebuilt = env.stageTask('build');
    expect(rebuilt.metadata.uid).not.toBe(build.metadata.uid);
    expect(rebuilt.spec.brief).toContain(CHANGE);
    expect(rebuilt.spec.brief).not.toContain('gh pr create');
    expect(rebuilt.spec.brief).toContain('--change-request ' + CHANGE);
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

  it('merges on the approval of a GitHub App, which Fleet records without its [bot] suffix', () => {
    const { env } = building({ review: { approver: 'Review-App[bot]' } });
    approve(env, {
      reviews: [{ id: 'r1', author: 'review-app', state: 'approved', head: HEAD }],
    });
    expect(env.merges()).toEqual([{ url: CHANGE, head: HEAD, method: 'squash' }]);
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

const NEXT = 'c'.repeat(40);
const TICKET = `${PROJECT}#1`;
const failed = (id: string) => ({
  id,
  checks: 'failed',
  failing: [{ name: 'CI', url: `https://forge.test/ci/${id.slice(0, 7)}` }],
});
const mine = (env: Env) =>
  (env.stageTask('build').spec.amendments ?? []).filter(
    (a: any) => a.from === 'plugin/fleet-factory',
  );
const conclude = (env: Env) =>
  env.result(env.stageTask('build').metadata.name, { changeUrl: CHANGE });
const progressing = (env: Env) =>
  env.list('ticket')[0].status.conditions.find((c: any) => c.type === 'Progressing');
const HOUR = 3_600_000;
const stuckAfter = {
  build: { taskConfig: 'factory-build', readyPolicy: 'checks', stuckAfterMs: HOUR },
};

describe.skipIf(!FLEET)('the build stage stays on its change until it is ready', () => {
  it('amends the concluded build Task once per failed draft head', () => {
    const { env } = building();
    conclude(env);
    env.setChange(11, { state: 'draft', head: failed(HEAD) });
    env.sweep(3);
    expect(
      env.list('task').filter((t) => t.metadata.labels?.['fleet-factory/stage'] === 'build'),
    ).toHaveLength(1);
    expect(mine(env)).toHaveLength(1);
    expect(mine(env)[0].text).toContain(HEAD);
    expect(mine(env)[0].text).toContain('CI');
    expect(mine(env)[0].reason).toContain(`feature.ticket="${TICKET}"`);

    env.sweep(3);
    expect(mine(env)).toHaveLength(1);

    conclude(env);
    env.setChange(11, { state: 'draft', head: failed(NEXT) });
    env.sweep(3);
    expect(mine(env)).toHaveLength(2);
    expect(mine(env)[1].text).toContain(NEXT);
  });

  it('amends neither a concluded Task on a draft head that did not fail nor a running one', () => {
    const { env } = building();
    env.setChange(11, { state: 'draft', head: failed(HEAD) });
    env.sweep(3);
    expect(mine(env)).toHaveLength(0);

    env.setChange(11, { state: 'draft', head: { id: NEXT, checks: 'pending' } });
    env.sweep(2);
    conclude(env);
    env.sweep(3);
    expect(mine(env)).toHaveLength(0);
    expect(env.stageTask('build').status.phase).toBe('Concluded');
  });

  it('records the build result only once the change is ready, merged or closed', () => {
    const { build } = building();
    const brief: string = build.spec.brief;
    const waits = brief.indexOf('until Fleet marks the change ready');
    expect(waits).toBeGreaterThan(-1);
    expect(brief.indexOf('fleet result')).toBeGreaterThan(waits);
    expect(brief).toContain('Never record a result while the change is a draft');
  });

  it('shows the declared change and follows its head while building', () => {
    const { env } = building();
    expect(env.list('ticket')[0].status.change).toMatchObject({
      url: CHANGE,
      head: HEAD,
      merged: false,
    });
    env.setChange(11, { state: 'draft', head: { id: NEXT, checks: 'pending' } });
    env.sweep(2);
    expect(env.list('ticket')[0].status.change).toMatchObject({ head: NEXT, merged: false });
  });

  it('moves a draft that stops moving to Stuck, and back to Building on a new head', () => {
    const { env } = building(stuckAfter);
    const comments = env.ticket(1).comments.length;
    env.backdateHeads(2 * HOUR);
    env.sweep(2);
    expect(phase(env)).toBe('Stuck');
    expect(progressing(env)).toMatchObject({ status: 'False', reason: 'ChangeStuck' });
    expect(progressing(env).message).toContain(CHANGE);
    expect(progressing(env).message).toContain(HEAD);
    expect(env.stageTask('build')).toBeDefined();
    expect(env.ticket(1).comments).toHaveLength(comments);
    expect(env.merges()).toHaveLength(0);

    env.setChange(11, { state: 'draft', head: { id: NEXT, checks: 'pending' } });
    env.sweep(2);
    expect(phase(env)).toBe('Building');
    expect(progressing(env)).toMatchObject({ status: 'True' });
  });

  it('moves a build Task that concluded with no change to Stuck with NoChange', () => {
    const env = refined();
    env.setTicket({ number: 1, labels: ['factory', 'factory:refined', 'factory:ready'] });
    env.sweep(2);
    conclude(env);
    env.sweep(2);
    expect(phase(env)).toBe('Stuck');
    expect(progressing(env)).toMatchObject({ status: 'False', reason: 'NoChange' });
    expect(env.stageTask('build')).toBeDefined();
  });
});
