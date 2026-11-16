import { manifest } from './manifest.ts';
import { observe, perform } from './observe.ts';
import * as source from './source.ts';
import * as ticket from './ticket.ts';
import type { J } from './util.ts';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function controller(kind: string) {
  if (kind === 'TicketSource') return source;
  if (kind === 'Ticket') return ticket;
  throw new Error(`unknown kind ${kind}`);
}

export async function answer(call: string, req: J): Promise<J> {
  const id = req?.id ?? null;
  try {
    switch (call) {
      case 'manifest':
        return { id, ok: true, manifest: manifest() };
      case 'probes':
        return { id, ok: true, probes: controller(req.object?.kind).probes(req) };
      case 'reconcile':
        return { id, ok: true, plan: controller(req.object?.kind).reconcile(req) };
      case 'observe':
        return { id, ok: true, ...(await observe(req.probe?.request)) };
      case 'perform':
        return { id, ok: true, outcome: await perform(req.effect?.request) };
      default:
        return { id, ok: false, why: `unknown call ${call}` };
    }
  } catch (e) {
    return { id, ok: false, why: String((e as Error)?.message ?? e) };
  }
}

async function main() {
  const call = process.argv[process.argv.length - 1] ?? '';
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const out: string[] = [];
  for (const line of input.split('\n')) {
    if (!line.trim()) continue;
    let req: J;
    try {
      req = JSON.parse(line);
    } catch (e) {
      out.push(JSON.stringify({ id: null, ok: false, why: `unreadable request: ${e}` }));
      continue;
    }
    out.push(JSON.stringify(await answer(call, req)));
  }
  process.stdout.write(out.map((l) => `${l}\n`).join(''));
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (entry === realpathSync(fileURLToPath(import.meta.url))) await main();
