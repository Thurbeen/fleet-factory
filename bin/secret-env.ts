import { execFileSync } from 'node:child_process';

const [name, program, ...args] = process.argv.slice(2);
if (!name || !program) {
  process.stderr.write('usage: secret-env.ts NAME /ABSOLUTE/PROGRAM [ARG...]\n');
  process.exit(2);
}
const value = execFileSync(program, args, { encoding: 'utf8' }).trim();
process.stdout.write(JSON.stringify({ [name]: value }));
