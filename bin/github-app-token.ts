import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const USAGE =
  'usage: github-app-token.ts --app-id ID --installation-id ID --key-file /ABSOLUTE/key.pem [--api-url URL]\n';

const base64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  )}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

async function main(): Promise<number> {
  const { values: o } = parseArgs({
    options: {
      'app-id': { type: 'string' },
      'installation-id': { type: 'string' },
      'key-file': { type: 'string' },
      'api-url': { type: 'string', default: 'https://api.github.com' },
    },
  });
  if (!o['app-id'] || !o['installation-id'] || !o['key-file']) {
    process.stderr.write(USAGE);
    return 2;
  }
  const jwt = appJwt(o['app-id'], readFileSync(o['key-file'], 'utf8'));
  const res = await fetch(
    `${o['api-url']}/app/installations/${encodeURIComponent(o['installation-id'])}/access_tokens`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'user-agent': 'fleet-factory',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(8000),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (res.status !== 201 || typeof body.token !== 'string') {
    process.stderr.write(`github-app-token: HTTP ${res.status} ${body.message ?? ''}\n`);
    return 1;
  }
  process.stdout.write(`${body.token}\n`);
  return 0;
}

process.exitCode = await main();
