import {
  type J,
  LABEL_SOURCE,
  boardRef,
  condition,
  deleting,
  known,
  sourceSpec,
  ticketName,
} from './util.ts';

const MAX_CREATES = 20;

export function probes(req: J): J[] {
  const me = req.object;
  const obs = req.observations ?? {};
  const spec = sourceSpec(me.spec);
  const out: J[] = [];
  if (deleting(me)) return out;
  if (!('tickets' in obs))
    out.push({
      id: 'tickets',
      type: 'plugin',
      request: { op: 'list', board: boardRef(spec), label: spec.board.intakeLabel },
    });
  if (!('mine' in obs))
    out.push({
      id: 'mine',
      type: 'list',
      kind: 'Ticket',
      labels: { [LABEL_SOURCE]: me.metadata.name },
    });
  return out;
}

export function reconcile(req: J): J {
  const me = req.object;
  const obs = req.observations ?? {};
  const now = Number(req.now ?? 0);
  const spec = sourceSpec(me.spec);
  const st = me.status ?? {};
  const listed = known(obs.tickets);
  const mine = known(obs.mine);
  const status: J = {
    phase: 'Listing',
    observedGeneration: me.metadata.generation,
    listedAt: st.listedAt ?? null,
    tickets: st.tickets ?? {},
    conditions: st.conditions ?? [],
  };
  if (!listed.ok || !mine.ok) {
    const why = !listed.ok ? listed.why : (mine as { why: string }).why;
    status.unknown = { why, at: now };
    status.conditions = [condition(st.conditions, 'Listed', 'Unknown', 'Unknown', why, now)];
    return { status, notBefore: now + 60_000 };
  }
  const tickets: J[] = listed.value ?? [];
  status.listedAt = now;
  status.tickets = Object.fromEntries(
    tickets.map((t) => [t.key, { number: t.number, url: t.url }]),
  );
  status.conditions = [
    condition(st.conditions, 'Listed', 'True', 'Listed', `${tickets.length} tickets`, now),
  ];
  const existing = new Set((mine.value ?? []).map((o: J) => o.metadata.name));
  const creates = tickets
    .map((t) => ({ t, name: ticketName(spec.board.project, t.number) }))
    .filter(({ name }) => !existing.has(name))
    .slice(0, MAX_CREATES)
    .map(({ t, name }) => ({
      apiVersion: 'fleet/v1alpha1',
      kind: 'Ticket',
      metadata: { name, labels: { [LABEL_SOURCE]: me.metadata.name } },
      spec: {
        source: me.metadata.name,
        key: t.key,
        project: spec.board.project,
        number: t.number,
        url: t.url,
      },
    }));
  return { status, creates, notBefore: now + spec.pollMs };
}
