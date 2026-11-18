export type BoardRef = { kind: string; project: string; tokenEnv?: string; apiUrl?: string };

export type TicketSummary = { key: string; number: number; url: string; labels: string[] };

export type CommentView = {
  id: number;
  author: string;
  type: string;
  permission: string;
  body: string;
  factory: string | null;
};

export type Account = { login: string; type: string; permission: string };

export type TicketView = TicketSummary & {
  title: string;
  body: string;
  author: Account;
  state: 'open' | 'closed';
  comments: CommentView[];
};

export type NewTicket = { title: string; body: string; labels: string[] };

export interface Board {
  list(ref: BoardRef, label: string): Promise<TicketSummary[]>;
  read(ref: BoardRef, number: number): Promise<TicketView | null>;
  comment(ref: BoardRef, number: number, marker: string, body: string): Promise<{ id: number }>;
  labels(ref: BoardRef, number: number, add: string[], remove: string[]): Promise<string[]>;
  create(
    ref: BoardRef,
    marker: string,
    ticket: NewTicket,
  ): Promise<{ number: number; url: string }>;
}

export class Unknown extends Error {}
