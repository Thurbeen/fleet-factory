import {
  amendedHeads,
  answersAmendment,
  buildBrief,
  failedChecksAmendment,
  followUpBody,
  watchBrief,
  watchComment,
  refineBrief,
  refinementComment,
  relayedComments,
} from './brief.ts';
import type { CommentView, TicketView } from './board/types.ts';
import {
  ACTIVE_PHASES,
  type J,
  LABEL_SOURCE,
  LABEL_STAGE,
  LABEL_TICKET,
  MARKER_REFINEMENT,
  type SourceSpec,
  WORKER_MARK,
  WRITERS,
  boardRef,
  condition,
  deleting,
  known,
  sameLogin,
  sourceSpec,
} from './util.ts';

const POLL_MS = 60_000;
const LABEL_NEEDS = 'factory:needs-decision';
const LABEL_REFINED = 'factory:refined';
const LABEL_READY = 'factory:ready';

const stageName = (me: J, stage: string) => `${me.metadata.name}-${stage}`;

function live(obs: J): J | null {
  const k = known(obs);
  return k.ok && k.value && !deleting(k.value) ? k.value : null;
}

function declaredChange(task: J): string | null {
  const d = (task?.status?.declared ?? []).find((x: J) => x?.kind === 'ChangeRequest');
  return d?.name ?? null;
}

export function probes(req: J): J[] {
  const me = req.object;
  const obs = req.observations ?? {};
  const out: J[] = [];
  const ask = (p: J) => {
    if (!(p.id in obs)) out.push(p);
  };
  ask({ id: 'source', type: 'object', kind: 'TicketSource', name: me.spec.source });
  ask({ id: 'refine', type: 'object', kind: 'Task', name: stageName(me, 'refine') });
  ask({ id: 'build', type: 'object', kind: 'Task', name: stageName(me, 'build') });
  ask({ id: 'watch', type: 'object', kind: 'Task', name: stageName(me, 'watch') });
  if (out.length) return out;
  const source = known(obs.source);
  if (!source.ok || !source.value || deleting(me)) return [];
  const spec = sourceSpec(source.value.spec);
  ask({
    id: 'ticket',
    type: 'plugin',
    request: { op: 'read', board: boardRef(spec), number: me.spec.number },
  });
  for (const stage of ['refine', 'build']) {
    const task = live(obs[stage]);
    if (!task?.spec?.dispatch)
      ask({
        id: `${stage}Queue`,
        type: 'list',
        kind: 'Task',
        labels: { [LABEL_SOURCE]: me.spec.source, [LABEL_STAGE]: stage },
      });
  }
  const st = me.status ?? {};
  if (st.change?.merged && !st.release && spec.watch.taskConfig && st.change.url)
    ask({
      id: 'release',
      type: 'plugin',
      request: { op: 'release', forge: spec.forge, url: st.change.url },
    });
  const change = declaredChange(live(obs.build));
  if (change) ask({ id: 'change', type: 'object', kind: 'ChangeRequest', name: change });
  return out;
}

function hasCapacity(queueObs: J, mine: string, maxActive: number): boolean {
  const queue = known(queueObs);
  if (!queue.ok) return false;
  const active = (queue.value ?? []).filter(
    (t: J) =>
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

type Said = { type: string; permission: string; body: string };

function byPerson(said: Said): boolean {
  return (
    said.type === 'User' && WRITERS.includes(said.permission) && !said.body.includes(WORKER_MARK)
  );
}

function humanDeciders(ticket: TicketView, relayed: number[]): string[] {
  const author = byPerson({ ...ticket.author, body: ticket.body }) ? [ticket.author.login] : [];
  const answerers = ticket.comments
    .filter((c) => relayed.includes(c.id) && byPerson(c))
    .map((c) => c.author);
  return [...author, ...answerers];
}

function refinement(result: J, humanAreas: string[], deciders: string[]) {
  const o = result.outputs ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const decisions = list(o.decisions);
  const questions = list(o.questions);
  const decidedByPerson = (by: unknown) =>
    typeof by === 'string' && deciders.some((login) => sameLogin(login, by));
  const undecided = decisions.filter(
    (d: J) => humanAreas.includes(d?.area) && !decidedByPerson(d?.by),
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
    (c) => c.id > asked.id && !c.factory && byPerson(c) && !relayed.includes(c.id),
  );
}

function taskManifest(me: J, stage: string, spec: J) {
  return {
    apiVersion: 'fleet/v1alpha1',
    kind: 'Task',
    metadata: {
      name: stageName(me, stage),
      labels: {
        [LABEL_SOURCE]: me.spec.source,
        [LABEL_TICKET]: me.metadata.name,
        [LABEL_STAGE]: stage,
      },
    },
    spec,
  };
}

function dispatchPatch(task: J, free: boolean): J[] {
  if (task.spec?.dispatch || !free) return [];
  return [
    { kind: 'Task', name: task.metadata.name, uid: task.metadata.uid, spec: { dispatch: true } },
  ];
}

type MergeGate =
  | { counted: true; head: string }
  | { counted: false; head: string; approver: string; decision: string };

function mergeGate(cr: J, spec: SourceSpec, ticket: TicketView): MergeGate | null {
  const s = cr?.status ?? {};
  const head = s.head?.id;
  if (!head || s.state?.value !== 'open' || !s.everReady) return null;
  if (s.head?.checks !== 'passed') return null;
  const approver = spec.approver;
  if (!approver || ticket.labels.includes(spec.merge.holdLabel)) return null;
  const approved = (s.reviews ?? []).some(
    (r: J) =>
      sameLogin(String(r.author ?? ''), approver) && r.state === 'approved' && r.head === head,
  );
  if (!approved) return null;
  const decision = String(s.reviewDecision?.value ?? 'none');
  if (decision === 'approved') return { counted: true, head };
  return { counted: false, head, approver, decision };
}

const unresolvedThreads = (cr: J) => Number(cr?.status?.threads?.unresolved ?? 1);

export function reconcile(req: J): J {
  const me = req.object;
  const obs = req.observations ?? {};
  const now = Number(req.now ?? 0);
  const st = me.status ?? {};
  const keep = { notBefore: now + POLL_MS };
  const source = known(obs.source);
  const ticketObs = known(obs.ticket);
  const refineObs = known(obs.refine);
  const buildObs = known(obs.build);
  if (!source.ok || !source.value || !ticketObs.ok || !refineObs.ok || !buildObs.ok) return keep;

  const spec = sourceSpec(source.value.spec);
  const board = boardRef(spec);
  const ticket: TicketView | null = ticketObs.value;
  const refineTask = live(obs.refine);
  const buildTask = live(obs.build);
  const status: J = {
    phase: st.phase ?? 'Refining',
    observedGeneration: me.metadata.generation,
    refinement: st.refinement ?? null,
    posted: st.posted ?? null,
    mergeRequested: st.mergeRequested ?? null,
    change: st.change ?? null,
    release: st.release ?? null,
    reported: st.reported ?? null,
    conditions: st.conditions ?? [],
  };
  const plan: J = { status, notBefore: now + POLL_MS };

  if (status.change?.merged) return watch(me, obs, spec, status, plan, now);

  const inScope =
    ticket && ticket.state === 'open' && ticket.labels.includes(spec.board.intakeLabel);
  if (!inScope) {
    status.phase = 'Dropped';
    status.conditions = [
      condition(st.conditions, 'InScope', 'False', ticket ? 'NotLabelled' : 'Gone', '', now),
    ];
    plan.deletes = [refineTask, buildTask]
      .filter(Boolean)
      .map((t: J) => ({ kind: 'Task', name: t.metadata.name, uid: t.metadata.uid }));
    return plan;
  }
  status.conditions = [condition(st.conditions, 'InScope', 'True', 'Labelled', '', now)];

  if (!refineTask) {
    status.phase = 'Refining';
    status.refinement = null;
    status.posted = null;
    plan.creates = [
      taskManifest(me, 'refine', {
        configRef: { name: spec.refine.taskConfig },
        workspace: [`git+${spec.repository.url}#${spec.repository.branch}`],
        brief: refineBrief(ticket!, spec.humanDecisions),
        dispatch: hasCapacity(obs.refineQueue, stageName(me, 'refine'), spec.maxActive.refine),
        outputs: {
          state: { type: 'string', required: true },
          decisions: { type: 'array', required: false },
          acceptance: { type: 'array', required: false },
          questions: { type: 'array', required: false },
        },
      }),
    ];
    return plan;
  }
  plan.patches = dispatchPatch(
    refineTask,
    hasCapacity(obs.refineQueue, refineTask.metadata.name, spec.maxActive.refine),
  );

  const result = currentResult(refineTask);
  const relayed = relayedComments(refineTask);
  if (!result) {
    if (!buildTask) return plan;
  } else {
    const r = refinement(result, spec.humanDecisions, humanDeciders(ticket!, relayed));
    status.refinement = r;
    const flipped = status.posted === r.generation && st.refinement?.state !== r.state;
    if (status.posted !== r.generation || flipped) {
      const refined = r.state === 'refined';
      const post = flipped ? `${r.generation}/${r.state}/${now}` : `${r.generation}`;
      status.phase = refined ? 'Refined' : 'NeedsDecision';
      plan.effects = [
        {
          key: `refinement/${post}`,
          request: {
            op: 'comment',
            board,
            number: me.spec.number,
            marker: MARKER_REFINEMENT,
            body: refinementComment(r),
          },
        },
        {
          key: `labels/${post}`,
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
    if (r.state !== 'refined') {
      status.phase = 'NeedsDecision';
      const fresh = answers(ticket!, relayed);
      if (fresh.length) {
        plan.amends = [
          {
            task: refineTask.metadata.name,
            uid: refineTask.metadata.uid,
            text: answersAmendment(fresh),
            reason: 'collaborators answered on the ticket',
            ifGeneration: Number(refineTask.metadata.generation),
          },
        ];
        status.phase = 'Refining';
      }
      return plan;
    }
  }

  const guarded = source.value.status?.guardrails?.ok === true;
  return build(me, obs, spec, ticket!, buildTask, status, plan, now, guarded);
}

function build(
  me: J,
  obs: J,
  spec: SourceSpec,
  ticket: TicketView,
  buildTask: J | null,
  status: J,
  plan: J,
  now: number,
  guarded: boolean,
): J {
  if (!buildTask) {
    status.phase = 'Refined';
    const gate = spec.buildGate === 'auto' || ticket.labels.includes(LABEL_READY);
    if (!gate || !guarded || !spec.build.taskConfig || !status.refinement) return plan;
    status.phase = 'Building';
    plan.creates = [
      taskManifest(me, 'build', {
        configRef: { name: spec.build.taskConfig },
        workspace: [`git+${spec.repository.url}#${spec.repository.branch}`],
        brief: buildBrief(ticket, status.refinement),
        dispatch: hasCapacity(obs.buildQueue, stageName(me, 'build'), spec.maxActive.build),
        outputs: { changeUrl: { type: 'string', required: true } },
        ...(spec.build.readyPolicy ? { forge: { draft: { policy: spec.build.readyPolicy } } } : {}),
      }),
    ];
    return plan;
  }
  plan.patches = [
    ...plan.patches,
    ...dispatchPatch(
      buildTask,
      hasCapacity(obs.buildQueue, buildTask.metadata.name, spec.maxActive.build),
    ),
  ];
  status.phase = 'Building';
  const declared = (buildTask.status?.declared ?? []).find((d: J) => d?.kind === 'ChangeRequest');
  if (!declared) {
    if (buildTask.status?.phase === 'Concluded')
      stuck(me, status, 'NoChange', `${buildTask.metadata.name} concluded without a change`, now);
    return plan;
  }
  const cr = live(obs.change);
  const state = cr?.status?.state?.value;
  const url = declared.url;
  if (!cr || !state) return plan;
  const head = cr.status?.head?.id ?? null;
  if (state === 'draft') return draft(me, spec, buildTask, cr, url, status, plan, now);
  if (state === 'merged') {
    status.phase = 'Merged';
    status.change = { url, head, merged: true, mergedAt: now };
    return plan;
  }
  if (state === 'closed') {
    status.phase = 'Closed';
    return plan;
  }
  if (state !== 'open') return plan;
  status.change = { url, head, merged: false };
  progressing(me, status, 'True', 'Ready', `${url} at ${head}`, now);
  status.phase = 'InReview';
  const gate = mergeGate(cr, spec, ticket);
  if (!gate) return plan;
  const unresolved = unresolvedThreads(cr);
  if (unresolved !== 0) {
    const message = `unresolved threads: ${unresolved} on ${url} at ${gate.head}; feature.ticket="${me.spec.key}"`;
    progressing(me, status, 'False', 'ThreadsUnresolved', message, now);
    return plan;
  }
  if (!gate.counted) {
    status.conditions = [
      ...status.conditions,
      condition(
        me.status?.conditions,
        'MergeReady',
        'False',
        'ApprovalNotCounted',
        `${gate.approver} approved ${gate.head} but GitHub reports review decision ${gate.decision}`,
        now,
      ),
    ];
    return plan;
  }
  const ready = gate.head;
  status.phase = 'Merging';
  status.conditions = [
    ...status.conditions,
    condition(me.status?.conditions, 'MergeReady', 'True', 'Approved', '', now),
  ];
  if (status.mergeRequested !== ready) {
    plan.effects = [
      ...(plan.effects ?? []),
      {
        key: `automerge/${ready}`,
        request: {
          op: 'automerge',
          forge: spec.forge,
          url,
          head: ready,
          method: spec.merge.method,
        },
      },
    ];
    status.mergeRequested = ready;
  }
  return plan;
}

function progressing(
  me: J,
  status: J,
  value: 'True' | 'False',
  reason: string,
  message: string,
  now: number,
) {
  status.conditions = [
    ...status.conditions.filter((c: J) => c?.type !== 'Progressing'),
    condition(me.status?.conditions, 'Progressing', value, reason, message, now),
  ];
}

function stuck(me: J, status: J, reason: string, message: string, now: number) {
  status.phase = 'Stuck';
  progressing(me, status, 'False', reason, message, now);
}

function draft(
  me: J,
  spec: SourceSpec,
  buildTask: J,
  cr: J,
  url: string,
  status: J,
  plan: J,
  now: number,
): J {
  const head = cr.status?.head ?? {};
  status.change = { url, head: head.id ?? null, merged: false };
  const stuckAt = Number(head.firstSeenAt ?? now) + spec.build.stuckAfterMs;
  if (now >= stuckAt) {
    stuck(me, status, 'ChangeStuck', `${url} has stayed a draft at head ${head.id}`, now);
    return plan;
  }
  progressing(me, status, 'True', 'Following', `${url} at head ${head.id}`, now);
  plan.notBefore = Math.min(plan.notBefore, stuckAt);
  const concluded = buildTask.status?.phase === 'Concluded';
  if (!concluded || head.checks !== 'failed' || amendedHeads(buildTask).includes(head.id))
    return plan;
  plan.amends = [
    {
      task: buildTask.metadata.name,
      uid: buildTask.metadata.uid,
      text: failedChecksAmendment(url, head.id, Array.isArray(head.failing) ? head.failing : []),
      reason: `checks failed on draft head ${head.id}; feature.ticket="${me.spec.key}"`,
      ifGeneration: Number(buildTask.metadata.generation),
    },
  ];
  return plan;
}

function watch(me: J, obs: J, spec: SourceSpec, status: J, plan: J, now: number): J {
  status.phase = 'Merged';
  if (!spec.watch.taskConfig) return plan;
  if (!status.release) {
    const found = known(obs.release);
    if (!found.ok || !found.value) return plan;
    status.release = found.value;
  }
  status.phase = 'Released';
  const due = Number(status.release.publishedAt) + spec.watch.afterMs;
  if (now < due) {
    plan.notBefore = due;
    return plan;
  }
  const watchObs = known(obs.watch);
  if (!watchObs.ok) return plan;
  const task = live(obs.watch);
  const ticket = { key: me.spec.key, url: me.spec.url ?? '' };
  if (!task) {
    if (status.reported != null) return plan;
    status.phase = 'Watching';
    plan.creates = [
      taskManifest(me, 'watch', {
        configRef: { name: spec.watch.taskConfig },
        workspace: [`git+${spec.repository.url}#${status.release.tag}`],
        brief: watchBrief(ticket, status.refinement ?? { acceptance: [] }, status.release),
        dispatch: true,
        outputs: {
          verdict: { type: 'string', required: true },
          findings: { type: 'array', required: false },
        },
      }),
    ];
    return plan;
  }
  status.phase = 'Watching';
  const result = currentResult(task);
  if (!result) return plan;
  const generation = Number(result.generation);
  const verdict = String(result.outputs?.verdict ?? 'inconclusive');
  const findings: J[] = (
    Array.isArray(result.outputs?.findings) ? result.outputs.findings : []
  ).slice(0, spec.followUps.max);
  status.phase = findings.length ? 'FollowedUp' : 'Done';
  if (status.reported === generation) return plan;
  const board = boardRef(spec);
  plan.effects = [
    {
      key: `watch/${generation}`,
      request: {
        op: 'comment',
        board,
        number: me.spec.number,
        marker: 'watch',
        body: watchComment(verdict, status.release, findings),
      },
    },
    ...findings.map((f: J, i: number) => ({
      key: `followup/${generation}/${i}`,
      request: {
        op: 'create',
        board,
        marker: `followup-${me.metadata.name}-${generation}-${i}`,
        ticket: {
          title: String(f.title ?? 'Post-release finding'),
          body: followUpBody(ticket.url, status.release, f),
          labels: [
            spec.followUps.label,
            `factory:${f.kind === 'regression' ? 'regression' : 'improvement'}`,
          ],
        },
      },
    })),
  ];
  status.reported = generation;
  return plan;
}
