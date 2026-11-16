const str = { type: 'string', minLength: 1 };

const ticketSourceSpec = {
  type: 'object',
  additionalProperties: false,
  required: ['board', 'repository', 'stages'],
  properties: {
    board: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'project'],
      properties: {
        kind: { enum: ['github-issues', 'fake'] },
        project: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
        intakeLabel: str,
        tokenEnv: { type: 'string', pattern: '^[A-Z_][A-Z0-9_]*$' },
        apiUrl: {
          type: 'string',
          pattern: '^(https://|http://(127\\.0\\.0\\.1|localhost)(:[0-9]+)?(/|$))',
        },
      },
    },
    repository: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: { url: { type: 'string', pattern: '^https://' }, branch: str },
    },
    stages: {
      type: 'object',
      additionalProperties: false,
      required: ['refine'],
      properties: {
        refine: {
          type: 'object',
          additionalProperties: false,
          required: ['taskConfig'],
          properties: { taskConfig: str },
        },
      },
    },
    policy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxActive: {
          type: 'object',
          additionalProperties: false,
          properties: { refine: { type: 'integer', minimum: 1 } },
        },
        humanDecisions: { type: 'array', items: str, uniqueItems: true },
      },
    },
    pollMs: { type: 'integer', minimum: 60000 },
  },
};

const ticketSpec = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'key', 'project', 'number'],
  properties: {
    source: str,
    key: str,
    project: str,
    number: { type: 'integer', minimum: 1 },
    url: { type: 'string' },
  },
};

export function manifest() {
  return {
    protocol: 1,
    name: 'fleet-factory',
    kinds: [
      { kind: 'TicketSource', pollMs: 60000, spec: ticketSourceSpec },
      { kind: 'Ticket', pollMs: 60000, spec: ticketSpec, immutableSpec: true },
    ],
  };
}
