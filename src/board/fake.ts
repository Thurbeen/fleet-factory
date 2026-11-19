import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Account, type Board, type BoardRef, type TicketView, Unknown } from './types.ts';
import { PLUGIN, marker } from '../util.ts';

type Stored = {
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author?: Account;
  comments: { id: number; author: string; type?: string; permission: string; body: string }[];
};
type State = { tickets: Record<string, Stored>; nextComment: number };

function file(): string {
  const dir = process.env.FLEET_FACTORY_FAKE_DIR;
  if (!dir) throw new Unknown('FLEET_FACTORY_FAKE_DIR is not set');
  return join(dir, 'board.json');
}

function load(): State {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch (e) {
    if (e instanceof Unknown) throw e;
    throw new Unknown('fake board unreadable');
  }
}

function save(s: State) {
  const path = file();
  writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${path}.tmp`, path);
}

const url = (ref: BoardRef, n: number) => `https://board.test/${ref.project}/issues/${n}`;
const key = (ref: BoardRef, n: number) => `${ref.project}#${n}`;

function factoryMarker(body: string): string | null {
  const m = new RegExp(`<!-- ${PLUGIN}:([a-z0-9-]+) -->`).exec(body);
  return m ? m[1] : null;
}

function stored(s: State, ref: BoardRef, n: number): Stored {
  const t = s.tickets[key(ref, n)];
  if (!t) throw new Error(`no ticket ${key(ref, n)}`);
  return t;
}

export const fake: Board = {
  async list(ref, label) {
    return Object.entries(load().tickets)
      .filter(([k, t]) => k.startsWith(`${ref.project}#`) && t.state === 'open')
      .filter(([, t]) => t.labels.includes(label))
      .map(([k, t]) => {
        const number = Number(k.split('#')[1]);
        return { key: k, number, url: url(ref, number), labels: t.labels };
      });
  },

  async read(ref, number) {
    const t = load().tickets[key(ref, number)];
    if (!t) return null;
    const view: TicketView = {
      key: key(ref, number),
      number,
      url: url(ref, number),
      title: t.title,
      body: t.body,
      author: t.author ?? { login: '', type: '', permission: 'none' },
      state: t.state,
      labels: t.labels,
      comments: t.comments.map((c) => ({
        ...c,
        type: c.type ?? 'User',
        factory: factoryMarker(c.body),
      })),
    };
    return view;
  },

  async comment(ref, number, name, body) {
    const s = load();
    const t = stored(s, ref, number);
    const text = `${body}\n\n${marker(name)}`;
    const existing = t.comments.find((c) => c.body.includes(marker(name)));
    if (existing) {
      existing.body = text;
      save(s);
      return { id: existing.id };
    }
    const id = s.nextComment++;
    t.comments.push({ id, author: PLUGIN, type: 'Bot', permission: 'write', body: text });
    save(s);
    return { id };
  },

  async create(ref, name, ticket) {
    const s = load();
    const found = Object.entries(s.tickets).find(
      ([k, t]) => k.startsWith(`${ref.project}#`) && t.body.includes(marker(name)),
    );
    if (found) {
      const number = Number(found[0].split('#')[1]);
      return { number, url: url(ref, number) };
    }
    const numbers = Object.keys(s.tickets)
      .filter((k) => k.startsWith(`${ref.project}#`))
      .map((k) => Number(k.split('#')[1]));
    const number = Math.max(0, ...numbers) + 1;
    s.tickets[key(ref, number)] = {
      title: ticket.title,
      body: `${ticket.body}\n\n${marker(name)}`,
      state: 'open',
      labels: ticket.labels,
      comments: [],
    };
    save(s);
    return { number, url: url(ref, number) };
  },

  async labels(ref, number, add, remove) {
    const s = load();
    const t = stored(s, ref, number);
    t.labels = [...new Set([...t.labels.filter((l) => !remove.includes(l)), ...add])];
    save(s);
    return t.labels;
  },
};
