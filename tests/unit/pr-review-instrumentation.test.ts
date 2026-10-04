import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IGitService, IWorkspaceManager } from '../../src/domain/interfaces/git.interface.js';
import type { IAgentRunner, AgentRunResult } from '../../src/domain/interfaces/agent-runner.interface.js';
import type { IVcsClient } from '../../src/domain/interfaces/vcs-client.interface.js';
import type { PrReviewJobPayload } from '../../src/domain/interfaces/queue.interface.js';

// CAF-DASHBOARD-03 T2: a PR review / fix-review job writes its own
// pipeline_runs row + caf-reviewer agent_events. pipeline-instrumentation.js
// and connection.js are NOT mocked — the writes happen against a throwaway
// SQLite file, same approach as pipeline-instrumentation-integration.test.ts.

const tmpDir = mkdtempSync(join(tmpdir(), 'caf-dashboard-03-'));
const dbPath = join(tmpDir, 'test.sqlite');
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const loggerWarnMock = vi.fn();
vi.mock('../../src/infrastructure/logging/logger.js', () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: loggerWarnMock, error: vi.fn(), fatal: vi.fn(), child: vi.fn() },
}));

const readFixReviewLogMock = vi.fn();
const readInitialReviewReportMock = vi.fn();
vi.mock('../../src/infrastructure/reports/report-reader.js', () => ({
  readFixReviewLog: readFixReviewLogMock,
  readInitialReviewReport: readInitialReviewReportMock,
}));

const publishDashboardEventMock = vi.fn();
vi.mock('../../src/infrastructure/queue/dashboard-events.js', () => ({
  publishDashboardEvent: publishDashboardEventMock,
}));

const configMock = { db: { path: dbPath } };
vi.mock('../../src/config/index.js', () => ({ config: configMock }));

const { RunPrReviewUseCase } = await import('../../src/application/use-cases/run-pr-review.use-case.js');
const { PipelineRunRepository } = await import('../../src/infrastructure/db/pipeline-run.repository.js');
const { getDb } = await import('../../src/infrastructure/db/connection.js');
const { recordPipelineStarted, finalizePipelineRun, recordPullRequest, prReviewRunId } = await import(
  '../../src/infrastructure/db/pipeline-instrumentation.js'
);

const REPO = 'ganjardbc/umkm-pos';
let seq = 0;

function makeAgentResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

/** A fresh ticket key + job id per call, so tests sharing the one DB file don't see each other's rows. */
function makeJob(overrides: Partial<PrReviewJobPayload> = {}): PrReviewJobPayload & { ticketKey: string } {
  seq += 1;
  const ticketKey = `CAF-REV-${seq}`;
  return {
    jobId: `github-job-${seq}`,
    repoFullName: REPO,
    cloneUrl: `https://github.com/${REPO}.git`,
    prNumber: 42,
    prHeadBranch: `ai-agent/${ticketKey}`,
    mode: 'scoped',
    commentContext: [],
    ticketKey,
    ...overrides,
  };
}

describe('CAF-DASHBOARD-03: PR review job instrumentation', () => {
  let agentRunner: IAgentRunner;
  let vcsClient: IVcsClient;
  let useCase: InstanceType<typeof RunPrReviewUseCase>;
  const repo = () => new PipelineRunRepository(getDb());

  beforeEach(() => {
    vi.clearAllMocks();
    const gitService = { clone: vi.fn().mockResolvedValue(undefined) } as unknown as IGitService;
    const workspaceManager = {
      createWorkspace: vi.fn().mockResolvedValue('/tmp/workspace-1'),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
    } as unknown as IWorkspaceManager;
    agentRunner = { run: vi.fn().mockResolvedValue(makeAgentResult()) };
    vcsClient = {
      createPullRequest: vi.fn(),
      replyToReviewComment: vi.fn().mockResolvedValue(undefined),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
      createPullRequestReview: vi.fn().mockResolvedValue({ url: 'u', id: 1 }),
    } as unknown as IVcsClient;
    useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });

    readFixReviewLogMock.mockResolvedValue({
      mode: undefined,
      raw: '',
      entries: [
        { commentRef: '1', label: 'GENERAL', status: 'FIXED', note: '' },
        { commentRef: '2', label: 'GENERAL', status: 'SKIPPED', note: 'x' },
      ],
    });
    readInitialReviewReportMock.mockResolvedValue({ verdict: 'APPROVE', raw: 'Verdict: APPROVE' });
  });

  it.each(['scoped', 'global'] as const)('mode %s: one pr-review row, reviewer start/end, fix counts', async (mode) => {
    const job = makeJob({ mode });
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({ stdout: JSON.stringify({ total_cost_usd: 0.25 }) }),
    );
    await useCase.execute(job);

    const detail = repo().getRunById(prReviewRunId(job.jobId));
    expect(detail?.run).toMatchObject({
      kind: 'pr-review',
      reviewMode: mode,
      repoId: REPO,
      ticketId: job.ticketKey,
      prNumber: 42,
      attempt: 1,
      finalStatus: 'SUCCESS',
      reviewResult: { type: 'fix', fixed: 1, skipped: 1, notApplicable: 0 },
    });
    expect(detail?.run.endedAt).not.toBeNull();
    expect(detail?.events.map((e) => [e.agentName, e.pivPhase, e.eventType, e.outcome])).toEqual([
      ['caf-reviewer', 'verify', 'start', null],
      ['caf-reviewer', 'verify', 'end', 'OK'],
    ]);
    expect(detail?.events[1]).toMatchObject({ costUsd: 0.25, exitCode: 0, attempt: 1 });
  });

  it('mode initial: stores the verdict', async () => {
    const job = makeJob({ mode: 'initial' });
    readInitialReviewReportMock.mockResolvedValue({ verdict: 'CHANGES_REQUESTED', raw: 'Verdict: CHANGES REQUESTED' });
    await useCase.execute(job);

    expect(repo().getRunById(prReviewRunId(job.jobId))?.run).toMatchObject({
      kind: 'pr-review',
      reviewMode: 'initial',
      finalStatus: 'SUCCESS',
      reviewResult: { type: 'verdict', verdict: 'CHANGES_REQUESTED', postedAsComment: false },
    });
  });

  it('a failing agent ends the run as ERROR with no result, and the job still throws', async () => {
    const job = makeJob();
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 1, stderr: 'boom' }));
    await expect(useCase.execute(job)).rejects.toThrow(/exited with code 1/);

    const detail = repo().getRunById(prReviewRunId(job.jobId));
    expect(detail?.run).toMatchObject({ finalStatus: 'ERROR', reviewResult: null });
    expect(detail?.events.map((e) => [e.eventType, e.outcome])).toEqual([
      ['start', null],
      ['end', 'FAILED'],
    ]);
  });

  it('a BullMQ retry of the same job bumps attempt on the same row and clears the previous outcome', async () => {
    const job = makeJob();
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeAgentResult({ exitCode: 1 }));
    await expect(useCase.execute(job)).rejects.toThrow();
    await useCase.execute(job);

    const runs = repo()
      .getPipelineRuns(REPO, { limit: 500 }, 'pr-review')
      .filter((r) => r.ticketId === job.ticketKey);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ attempt: 2, finalStatus: 'SUCCESS' });
    expect(repo().getRunById(runs[0].id)?.events.map((e) => e.attempt)).toEqual([1, 1, 2, 2]);
  });

  it('two review jobs for the same ticket are two rows', async () => {
    const first = makeJob({ mode: 'initial' });
    const second = { ...first, jobId: `${first.jobId}-again`, mode: 'global' as const };
    await useCase.execute(first);
    await useCase.execute(second);

    const runs = repo()
      .getPipelineRuns(REPO, { limit: 500 }, 'pr-review')
      .filter((r) => r.ticketId === first.ticketKey);
    expect(runs.map((r) => r.reviewMode).sort()).toEqual(['global', 'initial']);
  });

  it("never touches the ticket's pipeline run row, and borrows its title", async () => {
    const job = makeJob({ mode: 'initial' });
    recordPipelineStarted(REPO, job.ticketKey, 'Date filter on the sales report');
    finalizePipelineRun(REPO, job.ticketKey, 'SUCCESS');
    recordPullRequest(REPO, job.ticketKey, 42);
    const before = repo().getPipelineDetail(REPO, job.ticketKey);

    await useCase.execute(job);

    expect(repo().getPipelineDetail(REPO, job.ticketKey)).toEqual(before);
    expect(before?.run).toMatchObject({ kind: 'pipeline', attempt: 1, finalStatus: 'SUCCESS', prNumber: 42 });
    expect(repo().getRunById(prReviewRunId(job.jobId))?.run.ticketTitle).toBe('Date filter on the sales report');
  });

  it('falls back to the PR number as the title when the ticket has no pipeline run recorded', async () => {
    const job = makeJob();
    await useCase.execute(job);
    expect(repo().getRunById(prReviewRunId(job.jobId))?.run.ticketTitle).toBe('PR #42');
  });

  it('nudges the dashboard on every write', async () => {
    const job = makeJob();
    await useCase.execute(job);
    // start, agent start, agent end, finalize
    expect(publishDashboardEventMock).toHaveBeenCalledTimes(4);
    expect(publishDashboardEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: REPO, ticketId: job.ticketKey, eventType: 'change' }),
    );
  });
});
