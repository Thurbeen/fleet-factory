import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach } from 'vitest';

const SERVER = resolve(import.meta.dirname, 'github-server.ts');
const servers: ChildProcess[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
});

export async function startGitHub(): Promise<string> {
  const child = spawn(process.execPath, [SERVER], { stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(child);
  const port = await new Promise<string>((done) =>
    child.stdout!.once('data', (d) => done(String(d).trim())),
  );
  return `http://127.0.0.1:${port}`;
}

export async function state(api: string, patch?: object): Promise<any> {
  const r = await fetch(`${api}/__state`, {
    method: patch ? 'PUT' : 'GET',
    body: patch ? JSON.stringify(patch) : undefined,
  });
  return r.json();
}
