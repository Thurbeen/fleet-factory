import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const reportFailure = args[0] === '--report-failure';
const [name, program, ...rest] = reportFailure ? args.slice(1) : args;
if (!name || !program) {
  process.stderr.write('usage: secret-env.ts [--report-failure] NAME /ABSOLUTE/PROGRAM [ARG...]\n');
  process.exit(2);
}
const run = spawnSync(program, rest, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', reportFailure ? 'pipe' : 'inherit'],
});
if (run.status === 0) {
  process.stdout.write(JSON.stringify({ [name]: run.stdout.trim() }));
} else if (reportFailure) {
  const why = (run.stderr || run.error?.message || `${program} exited ${run.status}`).trim();
  process.stdout.write(JSON.stringify({ [`${name}_ERROR`]: why }));
} else {
  process.exit(run.status ?? 1);
}
