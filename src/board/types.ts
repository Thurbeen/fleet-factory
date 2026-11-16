export type BoardRef = { kind: string; project: string; tokenEnv?: string; apiUrl?: string };

export type TicketSummary = { key: string; number: number; url: string; labels: string[] };

export type CommentView = {
  id: number;
  author: string;
  permission: string;
  body: string;
  factory: string | null;
};

export type TicketView = TicketSummary & {
  title: string;
  body: string;
  state: 'open' | 'closed';
  comments: CommentView[];
};

export interface Board {
  list(ref: BoardRef, label: string): Promise<TicketSummary[]>;
  read(ref: BoardRef, number: number): Promise<TicketView | null>;
  comment(ref: BoardRef, number: number, marker: string, body: string): Promise<{ id: number }>;
  labels(ref: BoardRef, number: number, add: string[], remove: string[]): Promise<string[]>;
}

export class Unknown extends Error {}
