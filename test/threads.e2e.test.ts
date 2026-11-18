import { describe, expect, it } from 'vitest';
import { FLEET } from './fleet-env.ts';
import { CHANGE, HEAD, approve, building, phase } from './flows.ts';

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
});
