import { answersAmendment, refineBrief, refinementComment, relayedComments } from './brief.ts';
import type { CommentView, TicketView } from './board/types.ts';
import {
  ACTIVE_PHASES,
  type J,
  LABEL_SOURCE,
  LABEL_STAGE,
  LABEL_TICKET,
  MARKER_REFINEMENT,
  WRITERS,
  boardRef,
  condition,
  deleting,
  known,
  sourceSpec,
} from './util.ts';

const POLL_MS = 60_000;
const LABEL_NEEDS = 'factory:needs-decision';
const LABEL_REFINED = 'factory:refined';

const refineName = (me: J) => `${me.metadata.name}-refine`;

export function probes(req: J): J[] {
  const me = req.object;
  const obs = req.observations ?? {};
  const out: J[] = [];
  const ask = (p: J) => {
    if (!(p.id in obs)) out.push(p);
  };
  ask({ id: 'source', type: 'object', kind: 'TicketSource', name: me.spec.source });
  ask({ id: 'refine', type: 'object', kind: 'Task', name: refineName(me) });
  if (out.length) return out;
  const source = known(obs.source);
  if (!source.ok || !source.value || deleting(me)) return [];
  const spec = sourceSpec(source.value.spec);
  ask({
    id: 'ticket',
    type: 'plugin',
    request: { op: 'read', board: boardRef(spec), number: me.spec.number },
  });
  const task = known(obs.refine);
  if (!task.ok || !task.value || !task.value.spec?.dispatch)
    ask({
      id: 'queue',
      type: 'list',
      kind: 'Task',
      labels: { [LABEL_SOURCE]: me.spec.source, [LABEL_STAGE]: 'refine' },
    });
  return out;
}

function hasCapacity(queue: J[], mine: string, maxActive: number): boolean {
  const active = queue.filter(
    (t) =>
      !deleting(t) &&
      t.metadata?.name !== mine &&
      t.spec?.dispatch &&
      ACTIVE_PHASES.includes(t.status?.phase ?? 'Pending'),
  ).length;
  return active < maxActive;
}

function currentResult(task: J): J | null {
  const r = task?.status?.result;
  if (!r || task.status?.phase !== 'Concluded') return null;
  return Number(r.generation) === Number(task.metadata.generation) ? r : null;
}

function refinement(result: J, humanAreas: string[]) {
  const o = result.outputs ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const decisions = list(o.decisions);
  const questions = list(o.questions);
  const undecided = decisions.filter(
    (d: J) => humanAreas.includes(d?.area) && (!d?.by || d.by === 'agent'),
  );
  const refined = o.state === 'refined' && questions.length === 0 && undecided.length === 0;
  return {
    generation: Number(result.generation),
    state: refined ? 'refined' : 'needs-decision',
    decisions,
    acceptance: list(o.acceptance),
    questions,
  };
}

function answers(ticket: TicketView, relayed: number[]): CommentView[] {
  const asked = ticket.comments.find((c) => c.factory === MARKER_REFINEMENT);
  if (!asked) return [];
  return ticket.comments.filter(
    (c) =>
      c.id > asked.id && !c.factory && WRITERS.includes(c.permission) && !relayed.includes(c.id),
  );
}

export function reconcile(req: J): J {
  const me = req.object;
  const obs = req.observations ?? {};
  const now = Number(req.now ?? 0);
  const st = me.status ?? {};
  const keep = { notBefore: now + POLL_MS };
  const source = known(obs.source);
  const ticketObs = known(obs.ticket);
  const taskObs = known(obs.refine);
  if (!source.ok || !source.value || !ticketObs.ok || !taskObs.ok) return keep;

  const spec = sourceSpec(source.value.spec);
  const board = boardRef(spec);
  const ticket: TicketView | null = ticketObs.value;
  const task: J = taskObs.value && !deleting(taskObs.value) ? taskObs.value : null;
  const status: J = {
    phase: st.phase ?? 'Refining',
    observedGeneration: me.metadata.generation,
    refinement: st.refinement ?? null,
    posted: st.posted ?? null,
    conditions: st.conditions ?? [],
  };
  const plan: J = { status, notBefore: now + POLL_MS };

  const inScope =
    ticket && ticket.state === 'open' && ticket.labels.includes(spec.board.intakeLabel);
  if (!inScope) {
    status.phase = 'Dropped';
    status.conditions = [
      condition(st.conditions, 'InScope', 'False', ticket ? 'NotLabelled' : 'Gone', '', now),
    ];
    if (task) plan.deletes = [{ kind: 'Task', name: task.metadata.name, uid: task.metadata.uid }];
    return plan;
  }
  status.conditions = [condition(st.conditions, 'InScope', 'True', 'Labelled', '', now)];

  const queue = known(obs.queue);
  const free = queue.ok && hasCapacity(queue.value ?? [], refineName(me), spec.maxActive.refine);

  if (!task) {
    if (status.phase === 'Dropped') status.phase = 'Refining';
    status.refinement = null;
    status.posted = null;
    plan.creates = [
      {
        apiVersion: 'fleet/v1alpha1',
        kind: 'Task',
        metadata: {
          name: refineName(me),
          labels: {
            [LABEL_SOURCE]: me.spec.source,
            [LABEL_TICKET]: me.metadata.name,
            [LABEL_STAGE]: 'refine',
          },
        },
        spec: {
          configRef: { name: spec.refine.taskConfig },
          workspace: [`git+${spec.repository.url}#${spec.repository.branch}`],
          brief: refineBrief(ticket!, spec.humanDecisions),
          dispatch: !!free,
          outputs: {
            state: { type: 'string', required: true },
            decisions: { type: 'array', required: false },
            acceptance: { type: 'array', required: false },
            questions: { type: 'array', required: false },
          },
        },
      },
    ];
    return plan;
  }

  if (!task.spec?.dispatch && free)
    plan.patches = [
      { kind: 'Task', name: task.metadata.name, uid: task.metadata.uid, spec: { dispatch: true } },
    ];

  const result = currentResult(task);
  if (result) {
    const r = refinement(result, spec.humanDecisions);
    status.refinement = r;
    status.phase = r.state === 'refined' ? 'Refined' : 'NeedsDecision';
    if (status.posted !== r.generation) {
      const refined = r.state === 'refined';
      plan.effects = [
        {
          key: `refinement/${r.generation}`,
          request: {
            op: 'comment',
            board,
            number: me.spec.number,
            marker: MARKER_REFINEMENT,
            body: refinementComment(r),
          },
        },
        {
          key: `labels/${r.generation}`,
          request: {
            op: 'labels',
            board,
            number: me.spec.number,
            add: [refined ? LABEL_REFINED : LABEL_NEEDS],
            remove: [refined ? LABEL_NEEDS : LABEL_REFINED],
          },
        },
      ];
      status.posted = r.generation;
      return plan;
    }
    if (status.phase === 'NeedsDecision') {
      const fresh = answers(ticket!, relayedComments(task));
      if (fresh.length) {
        plan.amends = [
          {
            task: task.metadata.name,
            uid: task.metadata.uid,
            text: answersAmendment(fresh),
            reason: 'collaborators answered on the ticket',
            ifGeneration: Number(task.metadata.generation),
          },
        ];
        status.phase = 'Refining';
      }
    }
  }
  return plan;
}
