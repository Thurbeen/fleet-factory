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
const THIS_REPO = 'OWNER/repo';
const FORK_REPO = 'someone/repo';

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
      HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
      RUN_ID: '${{ github.run_id }}',
    });
  });

  type Run = { id: number; head: string; status: string; workflow?: string; repo?: string };

  const apiRun = ({ id, head, status, workflow = 'CI', repo = THIS_REPO }: Run) => ({
    id,
    name: workflow,
    head_sha: head,
    status,
    head_repository: { full_name: repo },
  });

  function supersede(runs: Run[], failingId?: number) {
    const dir = mkdtempSync(join(tmpdir(), 'supersede-'));
    const log = join(dir, 'gh.log');
    writeFileSync(join(dir, 'runs.json'), JSON.stringify({ workflow_runs: runs.map(apiRun) }));
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        `echo "$*" >> ${log}`,
        `[ "$1" = "api" ] && cat ${join(dir, 'runs.json')}`,
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
        REPO: THIS_REPO,
        WORKFLOW: 'CI',
        HEAD_REF: 'feature',
        HEAD_SHA: CURRENT_HEAD,
        HEAD_REPO: THIS_REPO,
        RUN_ID: '10',
      },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    return { result, calls, cancelled: calls.filter((c) => c.startsWith('run cancel')) };
  }

  it('cancels every active run of an older head and names each one', () => {
    const { result, calls, cancelled } = supersede([
      { id: 1, head: OLDER_HEAD, status: 'in_progress' },
      { id: 2, head: OLDER_HEAD, status: 'queued' },
      { id: 3, head: OLDER_HEAD, status: 'pending' },
      { id: 4, head: OLDER_HEAD, status: 'waiting' },
      { id: 5, head: OLDER_HEAD, status: 'completed' },
      { id: 6, head: CURRENT_HEAD, status: 'in_progress' },
      { id: 7, head: CURRENT_HEAD, status: 'queued' },
    ]);
    expect(result.status).toBe(0);
    expect(calls[0]).toMatch(/^api repos\/OWNER\/repo\/actions\/runs /);
    expect(calls[0]).toContain('event=pull_request');
    expect(calls[0]).toContain('branch=feature');
    expect(cancelled.map((c) => c.split(' ')[2])).toEqual(['1', '2', '3', '4']);
    for (const id of [1, 2, 3, 4]) {
      expect(result.stdout).toContain(`cancelled run ${id} of head ${OLDER_HEAD}`);
    }
  });

  it('leaves the runs of another workflow and of a fork branch with the same name alone', () => {
    const { result, cancelled } = supersede([
      { id: 1, head: OLDER_HEAD, status: 'in_progress', workflow: 'PR Title' },
      { id: 2, head: OLDER_HEAD, status: 'in_progress', repo: FORK_REPO },
      { id: 3, head: OLDER_HEAD, status: 'queued' },
    ]);
    expect(result.status).toBe(0);
    expect(cancelled.map((c) => c.split(' ')[2])).toEqual(['3']);
  });

  it('leaves the runs of a newer head alone when it starts late', () => {
    const { result, cancelled } = supersede([
      { id: 11, head: OLDER_HEAD, status: 'in_progress' },
      { id: 12, head: OLDER_HEAD, status: 'queued' },
    ]);
    expect(result.status).toBe(0);
    expect(cancelled).toEqual([]);
  });

  it('never fails the checks of the current head when a cancel fails', () => {
    const { result, cancelled } = supersede(
      [
        { id: 1, head: OLDER_HEAD, status: 'in_progress' },
        { id: 2, head: OLDER_HEAD, status: 'queued' },
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
