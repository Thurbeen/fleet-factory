const call = process.argv.at(-1);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const kind = (name: string) => ({
  kind: name,
  pollMs: 300000,
  finalizer: false,
  immutableSpec: false,
  spec: { type: 'object' },
  status: { type: 'object' },
});
const manifest = {
  protocol: 1,
  name: 'fleet-reviewer',
  kinds: [kind('ReviewSource'), kind('Review')],
};
for (const line of input.split('\n').filter((l) => l.trim())) {
  const { id } = JSON.parse(line);
  const answer =
    call === 'manifest'
      ? { id, ok: true, manifest }
      : { id, ok: false, why: `stub has no ${call}` };
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}
