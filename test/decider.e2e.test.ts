import { describe, expect, it } from 'vitest';
import { startGitHub, state } from './fake-github.ts';
import { type Author, Env, FLEET, PROJECT } from './fleet-env.ts';

const WORKER_MARK = '<!-- fleet:worker u1-abc -->';
const MAINTAINER: Author = { login: 'maintainer', type: 'User', permission: 'write' };
const QUESTION = { id: 'q1', text: 'Which columns?', area: 'scope' };

function started(author: Author = MAINTAINER, body = 'Customers want CSV.') {
  const env = new Env();
  env.setTicket({ number: 1, title: 'Export as CSV', body, labels: ['factory'], author });
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
  return { env, task: env.refineTask().metadata.name };
}

function decide(env: Env, task: string, by: string) {
  env.result(task, {
    state: 'refined',
    decisions: [{ id: 'd1', text: 'Date and total.', area: 'scope', by }],
    questions: [],
  });
  env.sweep(2);
}

function answer(env: Env, author: string, permission: string, body: string) {
  env.comment(1, author, permission, body);
  env.sweep(2);
}

const ticket = (env: Env) => env.list('ticket')[0];
const amendments = (env: Env, task: string) => env.get('task', task).spec.amendments ?? [];

describe.skipIf(!FLEET)('a4: only a person decides a human-owned area', () => {
  it('relays no Bot, outside or marked comment, and an unmarked User writer still refines', () => {
    const { env, task } = started();
    env.result(task, { state: 'needs-decision', questions: [QUESTION] });
    env.sweep(2);
    env.comment(1, 'review-app[bot]', 'write', 'Date and total.', 'Bot');
    env.comment(1, 'drive-by', 'read', 'Everything.');
    env.comment(1, 'operator', 'admin', `Relayed: date.\n\n${WORKER_MARK}`);
    env.sweep(2);
    expect(amendments(env, task)).toEqual([]);
    expect(ticket(env).status.phase).toBe('NeedsDecision');

    answer(env, 'operator', 'admin', 'Date and total.');
    expect(amendments(env, task)).toHaveLength(1);
    expect(amendments(env, task)[0].reason).toBe('collaborators answered on the ticket');
    expect(amendments(env, task)[0].text).toContain('Date and total.');
    expect(amendments(env, task)[0].text).not.toContain('Relayed: date.');
    expect(amendments(env, task)[0].text).not.toContain('Everything.');

    decide(env, task, 'stranger');
    expect(ticket(env).status.refinement.state).toBe('needs-decision');
    expect(ticket(env).status.phase).toBe('NeedsDecision');
    expect(env.ticket(1).labels).toContain('factory:needs-decision');

    answer(env, 'operator', 'admin', 'Yes, only those two.');
    expect(amendments(env, task)).toHaveLength(2);
    decide(env, task, '@Operator');
    expect(ticket(env).status.phase).toBe('Refined');
    expect(env.ticket(1).labels).toContain('factory:refined');
    expect(env.ticket(1).labels).not.toContain('factory:needs-decision');
  });

  it('counts an unmarked ticket author who is a User writer', () => {
    const { env, task } = started();
    decide(env, task, 'maintainer');
    expect(ticket(env).status.phase).toBe('Refined');
  });

  it('refuses a Bot, outside or marked ticket author, who decides only through an unmarked comment', () => {
    for (const [author, body] of [
      [MAINTAINER, `Customers want CSV.\n\n${WORKER_MARK}`],
      [{ ...MAINTAINER, type: 'Bot' }, 'Customers want CSV.'],
      [{ ...MAINTAINER, permission: 'read' }, 'Customers want CSV.'],
    ] as [Author, string][]) {
      const { env, task } = started(author, body);
      decide(env, task, 'maintainer');
      expect(ticket(env).status.phase, JSON.stringify(author)).toBe('NeedsDecision');
      if (author.type !== 'User' || author.permission !== 'write') continue;
      answer(env, 'maintainer', 'write', 'Date and total.');
      expect(amendments(env, task)).toHaveLength(1);
      decide(env, task, 'maintainer');
      expect(ticket(env).status.phase).toBe('Refined');
    }
  });

  it('falls back to needs-decision on a later sweep when the decider no longer qualifies', () => {
    const { env, task } = started();
    decide(env, task, 'maintainer');
    expect(ticket(env).status.phase).toBe('Refined');
    env.setTicket({ number: 1, author: { ...MAINTAINER, permission: 'read' } });
    env.sweep(2);
    expect(ticket(env).status.phase).toBe('NeedsDecision');
    expect(env.ticket(1).labels).toContain('factory:needs-decision');
    expect(env.ticket(1).labels).not.toContain('factory:refined');

    env.setTicket({ number: 1, author: MAINTAINER });
    env.sweep(2);
    expect(ticket(env).status.phase).toBe('Refined');
    expect(env.ticket(1).labels).toContain('factory:refined');
    expect(env.ticket(1).labels).not.toContain('factory:needs-decision');
  });

  it('reads account types and the issue author from GitHub', async () => {
    const api = await startGitHub();
    await state(api, {
      issues: {
        [`${PROJECT}#7`]: {
          number: 7,
          title: 'Export as CSV',
          body: `Customers want CSV.\n\n${WORKER_MARK}`,
          state: 'open',
          labels: ['factory'],
          comments: [],
          user: { login: 'maintainer', type: 'User' },
        },
      },
      permissions: { maintainer: 'write', 'review-app[bot]': 'write' },
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
    const task = env.refineTask().metadata.name;
    decide(env, task, 'maintainer');
    expect(ticket(env).status.phase).toBe('NeedsDecision');

    const s = await state(api);
    s.issues[`${PROJECT}#7`].comments.push(
      { id: 3001, user: { login: 'review-app[bot]', type: 'Bot' }, body: 'Date.' },
      { id: 3002, user: { login: 'maintainer', type: 'User' }, body: 'Date and total.' },
    );
    await state(api, { issues: s.issues });
    env.sweep(2);
    const amended = env.get('task', task).spec.amendments;
    expect(amended).toHaveLength(1);
    expect(amended[0].text).toContain('comment 3002');
    expect(amended[0].text).not.toContain('comment 3001');
    decide(env, task, 'maintainer');
    expect(ticket(env).status.phase).toBe('Refined');
  });
});
