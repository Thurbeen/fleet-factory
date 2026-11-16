import { describe, expect, it } from 'vitest';
import { type Env, FLEET } from './fleet-env.ts';
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
