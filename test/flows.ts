import { Env, GUARDED, PROJECT } from './fleet-env.ts';

export const HEAD = 'b'.repeat(40);
export const CHANGE = 'https://forge.test/example/app/pull/11';

export function refined(stages: object = {}): Env {
  const env = new Env();
  env.setTicket({
    number: 1,
    title: 'Export invoices as CSV',
    body: 'Customers want CSV.',
    labels: ['factory'],
    author: { login: 'maintainer', type: 'User', permission: 'write' },
  });
  for (const name of ['factory-refine', 'factory-build', 'factory-watch'])
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
        ...stages,
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

export function building(stages: object = {}): { env: Env; build: any } {
  const env = refined(stages);
  env.setTicket({ number: 1, labels: ['factory', 'factory:refined', 'factory:ready'] });
  env.sweep(2);
  const build = env.stageTask('build');
  env.setChange(11, { state: 'draft', head: { id: HEAD, checks: 'pending' } });
  env.ok('declare', build.metadata.name, '--change-request', CHANGE);
  env.sweep(2);
  return { env, build };
}

export function approve(env: Env, extra: object = {}) {
  env.setChange(11, {
    state: 'open',
    head: { id: HEAD, checks: 'passed' },
    reviews: [{ id: 'r1', author: 'reviewer-bot', state: 'approved', head: HEAD }],
    ...extra,
  });
  env.sweep(3);
}

export const phase = (env: Env) => env.list('ticket')[0].status.phase;
export { GUARDED };
