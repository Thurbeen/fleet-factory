import { describe, expect, it } from 'vitest';
import { startGitHub, state } from './fake-github.ts';
import { Env, FLEET, PROJECT } from './fleet-env.ts';

async function setup() {
  const api = await startGitHub();
  await state(api, {
    issues: {
      [`${PROJECT}#7`]: {
        number: 7,
        title: 'Export invoices as CSV',
        body: 'Customers want CSV.',
        state: 'open',
        labels: ['factory'],
        comments: [],
      },
      [`${PROJECT}#8`]: {
        number: 8,
        title: 'A pull request',
        body: '',
        state: 'open',
        labels: ['factory'],
        comments: [],
        pull_request: {},
      },
    },
    permissions: { maintainer: 'write', 'drive-by': 'read', 'factory-bot': 'write' },
  });
  const env = new Env({ FACTORY_BOARD_TOKEN: 'test-token' });
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
      board: {
        kind: 'github-issues',
        project: PROJECT,
        apiUrl: api,
        tokenEnv: 'FACTORY_BOARD_TOKEN',
      },
      repository: { url: 'https://forge.test/example/app', branch: 'main' },
      stages: { refine: { taskConfig: 'factory-refine' } },
    },
  });
  env.sweep(3);
  return { env, api };
}

describe.skipIf(!FLEET)('the GitHub Issues board through a real fleet', () => {
  it('refines a labelled issue, asks on it, and relays only a collaborator answer', async () => {
    const { env, api } = await setup();
    expect(env.list('ticket').map((t) => t.spec.key)).toEqual([`${PROJECT}#7`]);
    const task = env.refineTask();
    expect(task.spec.brief).toContain('https://github.test/example/app/issues/7');

    env.result(task.metadata.name, {
      state: 'needs-decision',
      questions: [{ id: 'q1', text: 'Which columns?', area: 'scope' }],
    });
    env.sweep(2);
    let s = await state(api);
    let issue = s.issues[`${PROJECT}#7`];
    expect(issue.labels).toContain('factory:needs-decision');
    const asked = issue.comments.filter((c: any) =>
      c.body.includes('<!-- fleet-factory:refinement -->'),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0].body).toContain('Which columns?');

    issue.comments.push({ id: 2001, user: { login: 'drive-by' }, body: 'All of them.' });
    issue.comments.push({ id: 2002, user: { login: 'maintainer' }, body: 'Date and total.' });
    await state(api, { issues: s.issues });
    env.sweep(2);
    const amended = env.get('task', task.metadata.name);
    expect(amended.spec.amendments).toHaveLength(1);
    expect(amended.spec.amendments[0].text).toContain('Date and total.');
    expect(amended.spec.amendments[0].text).not.toContain('All of them.');

    env.result(task.metadata.name, {
      state: 'refined',
      decisions: [{ id: 'd1', text: 'Date and total.', area: 'scope', by: 'maintainer' }],
      questions: [],
    });
    env.sweep(2);
    s = await state(api);
    issue = s.issues[`${PROJECT}#7`];
    expect(issue.labels).toContain('factory:refined');
    expect(issue.labels).not.toContain('factory:needs-decision');
    const refined = issue.comments.filter((c: any) =>
      c.body.includes('<!-- fleet-factory:refinement -->'),
    );
    expect(refined.map((c: any) => c.id)).toEqual([asked[0].id]);
  });

  it('keeps its last status when GitHub throttles it', async () => {
    const { env, api } = await setup();
    await state(api, { throttle: true });
    env.sweep(2);
    const source = env.get('ticketsource', 'app');
    expect(source.status.unknown.why).toContain('rate limit');
    expect(Object.keys(source.status.tickets)).toEqual([`${PROJECT}#7`]);
    expect(env.list('ticket')).toHaveLength(1);
  });
});
