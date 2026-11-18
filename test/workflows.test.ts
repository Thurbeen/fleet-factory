import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { run?: string; env?: Record<string, string> };
type Job = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: { pull_request: { types?: string[]; branches?: string[] } };
  concurrency: { group: string; 'cancel-in-progress'?: boolean; queue?: string };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

const read = (name: string): Workflow =>
  parse(readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', name), 'utf8'));

const WORKFLOWS = ['ci.yml', 'pr-title.yml'];
const CURRENT_HEAD = 'c'.repeat(40);
const OLDER_HEAD = 'a'.repeat(40);

const needsOf = (job: Job) => [job.needs ?? []].flat();

describe.each(WORKFLOWS)('%s', (name) => {
  const workflow = read(name);

  it('lets a second run on one head wait for the first instead of cancelling it', () => {
    expect(workflow.concurrency.group).toContain('github.event.pull_request.number');
    expect(workflow.concurrency.group).toContain('github.event.pull_request.head.sha');
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.concurrency.queue).toBe('max');
  });

  it('starts with a supersede job that alone may cancel runs and that nothing waits on', () => {
    const [first, ...others] = Object.keys(workflow.jobs);
    expect(first).toBe('supersede');
    expect(workflow.jobs.supersede.permissions).toEqual({ actions: 'write' });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const other of others) {
      expect(workflow.jobs[other].permissions?.actions).toBeUndefined();
      expect(needsOf(workflow.jobs[other])).not.toContain('supersede');
    }
  });
});

describe('the supersede step', () => {
  const steps = () => WORKFLOWS.map((name) => read(name).jobs.supersede?.steps);
  const step = () => steps()[0]?.find((s) => s.run) ?? {};

  it('is the same in every workflow', () => {
    expect(steps()[0]).toBeDefined();
    expect(steps()[1]).toEqual(steps()[0]);
  });

  it('reads the PR and the head from the event', () => {
    expect(step().env).toMatchObject({
      GH_TOKEN: '${{ github.token }}',
      REPO: '${{ github.repository }}',
      WORKFLOW: '${{ github.workflow }}',
      HEAD_REF: '${{ github.head_ref }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
    });
  });

  function supersede(runs: object[], failingId?: number) {
    const dir = mkdtempSync(join(tmpdir(), 'supersede-'));
    const log = join(dir, 'gh.log');
    writeFileSync(join(dir, 'runs.json'), JSON.stringify(runs));
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        `echo "$*" >> ${log}`,
        `[ "$1 $2" = "run list" ] && cat ${join(dir, 'runs.json')}`,
        `[ "$1 $2 $3" = "run cancel ${failingId ?? ''}" ] && exit 1`,
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, 'gh'), 0o755);
    writeFileSync(log, '');
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step().run ?? 'false'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: 'token',
        REPO: 'OWNER/repo',
        WORKFLOW: 'CI',
        HEAD_REF: 'feature',
        HEAD_SHA: CURRENT_HEAD,
      },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    return { result, calls, cancelled: calls.filter((c) => c.startsWith('run cancel')) };
  }

  it('cancels every active run of an older head and names each one', () => {
    const { result, calls, cancelled } = supersede([
      { databaseId: 1, headSha: OLDER_HEAD, status: 'in_progress' },
      { databaseId: 2, headSha: OLDER_HEAD, status: 'queued' },
      { databaseId: 3, headSha: OLDER_HEAD, status: 'pending' },
      { databaseId: 4, headSha: OLDER_HEAD, status: 'waiting' },
      { databaseId: 5, headSha: OLDER_HEAD, status: 'completed' },
      { databaseId: 6, headSha: CURRENT_HEAD, status: 'in_progress' },
      { databaseId: 7, headSha: CURRENT_HEAD, status: 'queued' },
    ]);
    expect(result.status).toBe(0);
    expect(calls[0]).toMatch(/^run list .*--workflow CI .*--branch feature/);
    expect(calls[0]).toContain('--event pull_request');
    expect(cancelled.map((c) => c.split(' ')[2])).toEqual(['1', '2', '3', '4']);
    for (const id of [1, 2, 3, 4]) {
      expect(result.stdout).toContain(`cancelled run ${id} of head ${OLDER_HEAD}`);
    }
  });

  it('never fails the checks of the current head when a cancel fails', () => {
    const { result, cancelled } = supersede(
      [
        { databaseId: 1, headSha: OLDER_HEAD, status: 'in_progress' },
        { databaseId: 2, headSha: OLDER_HEAD, status: 'queued' },
      ],
      1,
    );
    expect(result.status).toBe(0);
    expect(cancelled).toHaveLength(2);
    expect(result.stdout).toContain(`could not cancel run 1 of head ${OLDER_HEAD}`);
  });
});

describe('PR Title', () => {
  const workflow = read('pr-title.yml');

  it('still reports on every new head', () => {
    expect(workflow.on.pull_request.types).toEqual(['opened', 'edited', 'synchronize', 'reopened']);
  });

  it('checks an edit only when it changed the title', () => {
    expect(workflow.jobs['pr-title'].if).toBe(
      "github.event.action != 'edited' || github.event.changes.title != null",
    );
  });
});

describe('CI', () => {
  const workflow = read('ci.yml');

  it('runs on drafts', () => {
    expect(workflow.on.pull_request.types).toBeUndefined();
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if ?? '').not.toContain('draft');
    }
  });
});
