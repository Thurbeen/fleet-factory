import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach } from 'vitest';

const SERVER = resolve(import.meta.dirname, 'github-server.ts');
const servers: ChildProcess[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
});

async function start(args: string[]): Promise<string[]> {
  const child = spawn(process.execPath, [SERVER, ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  servers.push(child);
  const ports = await new Promise<string>((done) =>
    child.stdout!.once('data', (d) => done(String(d).trim())),
  );
  return ports.split(' ');
}

export async function startGitHub(): Promise<string> {
  const [port] = await start([]);
  return `http://127.0.0.1:${port}`;
}

export async function startGitHubWithGit(): Promise<{ api: string; git: string; ca: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-factory-tls-'));
  const key = join(dir, 'key.pem');
  const ca = join(dir, 'cert.pem');
  const cert = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      ca,
    ],
    { encoding: 'utf8' },
  );
  if (cert.status !== 0) throw new Error(`openssl: ${cert.stderr}`);
  const [port, tlsPort] = await start([key, ca]);
  return { api: `http://127.0.0.1:${port}`, git: `https://127.0.0.1:${tlsPort}`, ca };
}

export async function state(api: string, patch?: object): Promise<any> {
  const r = await fetch(`${api}/__state`, {
    method: patch ? 'PUT' : 'GET',
    body: patch ? JSON.stringify(patch) : undefined,
  });
  return r.json();
}
