import { createHash } from 'node:crypto';

export type J = any;

export const PLUGIN = 'fleet-factory';
export const LABEL_SOURCE = 'fleet-factory/source';
export const LABEL_TICKET = 'fleet-factory/ticket';
export const LABEL_STAGE = 'fleet-factory/stage';
export const MARKER_REFINEMENT = 'refinement';
export const ACTIVE_PHASES = ['Pending', 'Spawning', 'Spawned', 'Briefed'];
export const WRITERS = ['admin', 'maintain', 'write'];

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
    },
    approver: spec?.stages?.review?.approver as string | undefined,
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
