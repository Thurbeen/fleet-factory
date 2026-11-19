import { createHash } from 'node:crypto';
import { Unknown } from './board/types.ts';

export type J = any;

export const PLUGIN = 'fleet-factory';
export const LABEL_SOURCE = 'fleet-factory/source';
export const LABEL_TICKET = 'fleet-factory/ticket';
export const LABEL_STAGE = 'fleet-factory/stage';
export const MARKER_REFINEMENT = 'refinement';
export const ACTIVE_PHASES = ['Pending', 'Spawning', 'Spawned', 'Briefed'];
export const WRITERS = ['admin', 'maintain', 'write'];
export const WORKER_MARK = '<!-- fleet:worker';

export function sameLogin(a: string, b: string): boolean {
  const bare = (login: string) =>
    login
      .trim()
      .replace(/^@/, '')
      .toLowerCase()
      .replace(/\[bot\]$/, '');
  return bare(a) === bare(b);
}

export function tokenFrom(env: string | undefined): string {
  const name = env ?? 'GITHUB_TOKEN';
  const token = process.env[name];
  if (!token) throw new Unknown(process.env[`${name}_ERROR`] ?? `${name} is not set`);
  return token;
}

export function marker(name: string): string {
  return `<!-- ${PLUGIN}:${name} -->`;
}

export function ticketName(project: string, number: number): string {
  const repo =
    (project.split('/').pop() ?? 'repo')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .slice(0, 40)
      .replace(/^-+|-+$/g, '') || 'repo';
  const hash = createHash('sha256').update(`${project}#${number}`).digest('hex').slice(0, 6);
  return `t-${repo}-${number}-${hash}`;
}

export function sourceSpec(spec: J) {
  const board = spec?.board ?? {};
  const policy = spec?.policy ?? {};
  return {
    board: {
      kind: String(board.kind ?? ''),
      project: String(board.project ?? ''),
      intakeLabel: String(board.intakeLabel ?? 'factory'),
      tokenEnv: board.tokenEnv as string | undefined,
      apiUrl: board.apiUrl as string | undefined,
    },
    repository: {
      url: String(spec?.repository?.url ?? ''),
      branch: String(spec?.repository?.branch ?? 'main'),
    },
    forge: {
      kind: String(spec?.forge?.kind ?? 'github'),
      tokenEnv: spec?.forge?.tokenEnv as string | undefined,
      apiUrl: spec?.forge?.apiUrl as string | undefined,
    },
    refine: { taskConfig: String(spec?.stages?.refine?.taskConfig ?? '') },
    build: {
      taskConfig: spec?.stages?.build?.taskConfig as string | undefined,
      readyPolicy: spec?.stages?.build?.readyPolicy as string | undefined,
      stuckAfterMs: Number(spec?.stages?.build?.stuckAfterMs ?? 14_400_000),
    },
    approver: spec?.stages?.review?.approver as string | undefined,
    watch: {
      taskConfig: spec?.stages?.watch?.taskConfig as string | undefined,
      afterMs: Number(spec?.stages?.watch?.afterMs ?? 86_400_000),
    },
    followUps: {
      label: String(policy.followUps?.label ?? 'factory:proposed'),
      max: Number(policy.followUps?.max ?? 3),
    },
    buildGate: String(policy.buildGate ?? 'label'),
    merge: {
      method: String(spec?.merge?.method ?? 'squash'),
      holdLabel: String(spec?.merge?.holdLabel ?? 'factory:hold'),
    },
    maxActive: {
      refine: Number(policy.maxActive?.refine ?? 3),
      build: Number(policy.maxActive?.build ?? 2),
    },
    humanDecisions: (policy.humanDecisions ?? [
      'scope',
      'pricing',
      'data-retention',
      'security',
      'user-facing-copy',
    ]) as string[],
    pollMs: Math.max(Number(spec?.pollMs ?? 300_000), 60_000),
  };
}
export type SourceSpec = ReturnType<typeof sourceSpec>;

export function boardRef(spec: SourceSpec) {
  const { kind, project, tokenEnv, apiUrl } = spec.board;
  return { kind, project, tokenEnv, apiUrl };
}

export function condition(
  old: J[] | undefined,
  type: string,
  status: 'True' | 'False' | 'Unknown',
  reason: string,
  message: string,
  now: number,
): J {
  const prev = (old ?? []).find((c) => c?.type === type);
  const lastTransitionTime = prev && prev.status === status ? prev.lastTransitionTime : now;
  return { type, status, reason, message, lastTransitionTime };
}

export function known(obs: J): { ok: true; value: J } | { ok: false; why: string } {
  if (obs && typeof obs === 'object' && 'known' in obs) return { ok: true, value: obs.known };
  return { ok: false, why: String(obs?.unknown?.why ?? 'not asked') };
}

export function deleting(o: J): boolean {
  return o?.metadata?.deletionTimestamp != null;
}
