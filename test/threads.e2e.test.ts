import { describe, expect, it } from 'vitest';
import { type Env, FLEET, PROJECT } from './fleet-env.ts';
import { CHANGE, HEAD, approve, building, phase } from './flows.ts';

const progressing = (env: Env) =>
  env.list('ticket')[0].status.conditions.find((c: any) => c.type === 'Progressing');

describe.skipIf(!FLEET)('review threads on an approved change, through a real fleet', () => {
  it('merges once the reviewer resolves its last thread on the approved head, with no new review', () => {
    const { env } = building();
    approve(env, { threads: { unresolved: 1 } });
    expect(env.merges()).toHaveLength(0);
    expect(phase(env)).toBe('InReview');

    approve(env, { threads: { unresolved: 0 } });
    expect(env.merges()).toEqual([{ url: CHANGE, head: HEAD, method: 'squash' }]);
    expect(phase(env)).toBe('Merging');
    env.sweep(3);
    expect(env.merges()).toHaveLength(1);
  });

  it('never requests auto-merge while a thread stays open on the approved head', () => {
    const { env } = building();
    approve(env, { threads: { unresolved: 1 } });
    env.sweep(4);
    expect(env.merges()).toHaveLength(0);
    expect(phase(env)).toBe('InReview');
    expect(env.list('ticket')[0].status.mergeRequested).toBeNull();
  });

  it('tells the build Task never to resolve a review thread', () => {
    const { build } = building();
    expect(build.spec.brief).toContain('Never resolve a review thread');
  });

  it('shows why an approved change with passed checks waits on its unresolved threads', () => {
    const { env } = building();
    approve(env, { threads: { unresolved: 2 } });
    expect(phase(env)).toBe('InReview');
    expect(progressing(env)).toMatchObject({ reason: 'ThreadsUnresolved' });
    expect(progressing(env).message).toContain('2 unresolved threads');
    expect(progressing(env).message).toContain(`feature.ticket="${PROJECT}#1"`);
    expect(env.merges()).toHaveLength(0);

    approve(env, { threads: { unresolved: 0 } });
    expect(phase(env)).toBe('Merging');
    expect(progressing(env).reason).not.toBe('ThreadsUnresolved');
  });

  it('does not blame threads while the head waits for its approval or its checks', () => {
    const { env } = building();
    env.setChange(11, {
      state: 'open',
      head: { id: HEAD, checks: 'pending' },
      reviews: [{ id: 'r1', author: 'reviewer-bot', state: 'approved', head: HEAD }],
      threads: { unresolved: 1 },
    });
    env.sweep(3);
    expect(progressing(env).reason).not.toBe('ThreadsUnresolved');
  });
});
