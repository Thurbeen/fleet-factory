import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Env, FLEET, PROJECT } from './fleet-env.ts';
import { CHANGE, HEAD, approve, building, phase } from './flows.ts';

const WATCH = { watch: { taskConfig: 'factory-watch', afterMs: 1000 } };

function merged(): Env {
  const { env } = building(WATCH);
  approve(env);
  env.setChange(11, { state: 'merged', head: { id: HEAD, checks: 'passed' } });
  env.sweep(3);
  return env;
}

function release(env: Env, publishedAt: number) {
  writeFileSync(
    join(env.board, 'releases.json'),
    JSON.stringify([
      { tag: 'v1.2.0', url: 'https://forge.test/r/v1.2.0', publishedAt, changes: [CHANGE] },
    ]),
  );
}

const FINDING = {
  kind: 'improvement',
  title: 'CSV export p95 is above its SLO',
  evidence: 'p95 2.4 s over 24 h, SLO 1 s',
  criterion: 'a1',
};

describe.skipIf(!FLEET)('the post-release watch through a real fleet', () => {
  it('waits for a release that contains the merge', () => {
    const env = merged();
    env.sweep(2);
    expect(phase(env)).toBe('Merged');
    expect(env.stageTask('watch')).toBeUndefined();
  });

  it('watches the release after the window and files each finding as a proposed ticket', () => {
    const env = merged();
    release(env, Date.now() - 60_000);
    env.sweep(3);
    const watch = env.stageTask('watch');
    expect(env.list('ticket')[0].status.release).toMatchObject({ tag: 'v1.2.0' });
    expect(watch.spec.configRef).toEqual({ name: 'factory-watch' });
    expect(watch.spec.brief).toContain('v1.2.0');
    expect(watch.spec.brief).toContain('csv_exports_total');
    expect(watch.spec.brief).toContain(`feature.ticket="${PROJECT}#1"`);
    expect(watch.spec.outputs.verdict).toEqual({ type: 'string', required: true });

    env.result(watch.metadata.name, { verdict: 'degraded', findings: [FINDING] });
    env.sweep(3);
    const board = env.readBoard();
    const filed = Object.entries(board.tickets).filter(([, t]) =>
      t.labels.includes('factory:proposed'),
    );
    expect(filed).toHaveLength(1);
    const [, ticket] = filed[0];
    expect(ticket.title).toBe('CSV export p95 is above its SLO');
    expect(ticket.labels).toEqual(['factory:proposed', 'factory:improvement']);
    expect(ticket.body).toContain('p95 2.4 s over 24 h, SLO 1 s');
    expect(ticket.body).toContain('https://board.test/example/app/issues/1');
    const report = env
      .ticket(1)
      .comments.find((c) => c.body.includes('<!-- fleet-factory:watch -->'));
    expect(report?.body).toContain('degraded');
    expect(phase(env)).toBe('FollowedUp');

    env.sweep(3);
    expect(Object.keys(env.readBoard().tickets)).toHaveLength(Object.keys(board.tickets).length);
  });

  it('ends Done with a report when the release is healthy', () => {
    const env = merged();
    release(env, Date.now() - 60_000);
    env.sweep(3);
    env.result(env.stageTask('watch').metadata.name, { verdict: 'healthy', findings: [] });
    env.sweep(3);
    expect(phase(env)).toBe('Done');
    expect(
      env.ticket(1).comments.some((c) => c.body.includes('<!-- fleet-factory:watch -->')),
    ).toBe(true);
  });
});
