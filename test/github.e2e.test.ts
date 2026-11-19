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
        user: { login: 'maintainer', type: 'User' },
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
    permissions: {
      maintainer: 'write',
      answerer: 'write',
      operator: 'admin',
      'drive-by': 'read',
      'factory-bot': 'write',
      'helper-app[bot]': 'write',
    },
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
    expect(task.spec.brief).toContain('Opened by: maintainer');
    expect(task.spec.brief).toContain('ticket author decided it in the body');

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

const WORKER_MARK = '<!-- fleet:worker u1-0123456789abcdef -->';
const QUESTION = { id: 'q1', text: 'Which columns?', area: 'scope' };
const decidedBy = (by: string) => ({
  state: 'refined',
  decisions: [{ id: 'd1', text: 'Date and total.', area: 'scope', by }],
  questions: [],
});

async function addComment(api: string, user: object, body: string) {
  const s = await state(api);
  const issue = s.issues[`${PROJECT}#7`];
  issue.comments.push({ id: s.nextId, user, body });
  await state(api, { issues: s.issues, nextId: s.nextId + 1 });
}

const labelsOf = async (api: string): Promise<string[]> =>
  (await state(api)).issues[`${PROJECT}#7`].labels;

const notPeople: [string, { login: string; type: string }, string][] = [
  ['a Bot account', { login: 'helper-app[bot]', type: 'Bot' }, 'Date and total.'],
  ['a non-collaborator', { login: 'drive-by', type: 'User' }, 'Date and total.'],
  [
    'the author of a worker-marked comment',
    { login: 'operator', type: 'User' },
    `Date and total.\n\n${WORKER_MARK}`,
  ],
];

describe.skipIf(!FLEET)('the Refined gate counts only a person who can write', () => {
  it.each(notPeople)(
    'keeps a human-area decision by %s at needs-decision, and never relays its comment',
    async (_, user, body) => {
      const { env, api } = await setup();
      const task = env.refineTask();
      await addComment(api, user, body);
      env.result(task.metadata.name, decidedBy(user.login));
      env.sweep(2);
      expect(await labelsOf(api)).toContain('factory:needs-decision');
      expect(await labelsOf(api)).not.toContain('factory:refined');

      await addComment(api, user, body);
      env.sweep(2);
      expect(env.get('task', task.metadata.name).spec.amendments ?? []).toEqual([]);
    },
  );

  it('refines a human-area decision by the ticket author, whatever the case of the login', async () => {
    const { env, api } = await setup();
    env.result(env.refineTask().metadata.name, decidedBy('Maintainer'));
    env.sweep(2);
    expect(await labelsOf(api)).toContain('factory:refined');
  });

  it('refines a human-area decision by the author of a relayed answer', async () => {
    const { env, api } = await setup();
    const task = env.refineTask();
    env.result(task.metadata.name, { state: 'needs-decision', questions: [QUESTION] });
    env.sweep(2);
    expect(await labelsOf(api)).toContain('factory:needs-decision');

    await addComment(api, { login: 'answerer', type: 'User' }, 'Date and total.');
    env.sweep(2);
    const amended = env.get('task', task.metadata.name);
    expect(amended.spec.amendments).toHaveLength(1);
    expect(amended.spec.amendments[0].text).toContain('answerer wrote');

    env.result(task.metadata.name, decidedBy('answerer'));
    env.sweep(2);
    expect(await labelsOf(api)).toContain('factory:refined');
    expect(await labelsOf(api)).not.toContain('factory:needs-decision');
  });
});
