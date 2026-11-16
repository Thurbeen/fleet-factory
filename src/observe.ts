import { fake } from './board/fake.ts';
import { github } from './board/github.ts';
import { type Board, type BoardRef, Unknown } from './board/types.ts';
import type { J } from './util.ts';

const boards: Record<string, Board> = { fake, 'github-issues': github };

function board(ref: BoardRef): Board {
  const b = boards[ref?.kind];
  if (!b) throw new Error(`no board adapter ${ref?.kind}`);
  return b;
}

export async function observe(req: J): Promise<J> {
  try {
    switch (req?.op) {
      case 'list':
        return { known: await board(req.board).list(req.board, req.label) };
      case 'read':
        return { known: await board(req.board).read(req.board, req.number) };
      default:
        return { unknown: { why: `unknown op ${req?.op}` } };
    }
  } catch (e) {
    return { unknown: { why: String((e as Error)?.message ?? e) } };
  }
}

export async function perform(req: J): Promise<J> {
  try {
    switch (req?.op) {
      case 'comment':
        return {
          done: await board(req.board).comment(req.board, req.number, req.marker, req.body),
        };
      case 'labels':
        return {
          done: {
            labels: await board(req.board).labels(req.board, req.number, req.add, req.remove),
          },
        };
      default:
        return { failed: { why: `unknown op ${req?.op}` } };
    }
  } catch (e) {
    if (e instanceof Unknown) return { unknown: { why: e.message } };
    return { failed: { why: String((e as Error)?.message ?? e) } };
  }
}
