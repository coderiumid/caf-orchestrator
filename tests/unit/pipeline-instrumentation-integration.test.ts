import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IGitService, IWorkspaceManager } from '../../src/domain/interfaces/git.interface.js';
import type { IAgentRunner, AgentRunResult } from '../../src/domain/interfaces/agent-runner.interface.js';
import type { ILinearClient } from '../../src/domain/interfaces/linear-client.interface.js';
import type { INotifier } from '../../src/domain/interfaces/notifier.interface.js';
import type { IVcsClient } from '../../src/domain/interfaces/vcs-client.interface.js';
import type { ExistingJobPayload } from '../../src/domain/interfaces/queue.interface.js';

// CAF-DASHBOARD-01 Task 3 verify: drive a full pipeline run through the real
// (unmocked) pipeline-instrumentation.js + a real on-disk SQLite DB, and
// assert agent_events land in actual event order — not just that the writer
// functions were called with the right arguments.

const tmpDir = mkdtempSync(join(tmpdir(), 'caf-dashboard-01-'));
const dbPath = join(tmpDir, 'test.sqlite');
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const loggerWarnMock = vi.fn();
const loggerErrorMock = vi.fn();
vi.mock('../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerWarnMock,
    error: loggerErrorMock,
    fatal: vi.fn(),
    child: vi.fn(),
  },
}));

const routeTasksMock = vi.fn();
const hasDocsTasksMock = vi.fn();
const parseSkipDirectivesMock = vi.fn();
vi.mock('../../src/infrastructure/agent/task-router.js', () => ({
  routeTasks: routeTasksMock,
  hasDocsTasks: hasDocsTasksMock,
  parseSkipDirectives: parseSkipDirectivesMock,
}));

const readTasksMock = vi.fn();
const readVerifyReportMock = vi.fn();
const readQaReportMock = vi.fn();
const readReviewerReportMock = vi.fn();
const appendSkipNoteMock = vi.fn();
vi.mock('../../src/infrastructure/reports/report-reader.js', () => ({
  readTasks: readTasksMock,
  readVerifyReport: readVerifyReportMock,
  readQaReport: readQaReportMock,
  readReviewerReport: readReviewerReportMock,
  appendSkipNote: appendSkipNoteMock,
  taskDir: (workspacePath: string, ticketKey: string) => `${workspacePath}/.caf/tasks/${ticketKey}`,
}));

const recordGateFailureMock = vi.fn();
const resetOrchestrationStateMock = vi.fn();
const readOrchestrationStateMock = vi.fn();
const incrementOrchestrationRetryCountMock = vi.fn();
vi.mock('../../src/infrastructure/reports/orchestration-state.js', () => ({
  recordGateFailure: recordGateFailureMock,
  resetOrchestrationState: resetOrchestrationStateMock,
  readOrchestrationState: readOrchestrationStateMock,
  incrementOrchestrationRetryCountMock,
  incrementOrchestrationRetryCount: incrementOrchestrationRetryCountMock,
}));

// Real db.path pointed at a throwaway on-disk file — pipeline-instrumentation.js
// and connection.js are NOT mocked in this file, so agent_events/pipeline_runs
// writes actually happen against this SQLite file.
const configMock = {
  AGENT_SKIP_ENABLED: false,
  agents: { qa: { maxRetries: 1 }, reviewer: { maxRetries: 1 } },
  db: { path: dbPath },
};
vi.mock('../../src/config/index.js', () => ({ config: configMock }));

const { RunAgentPipelineUseCase } = await import(
  '../../src/application/use-cases/run-agent-pipeline.use-case.js'
);
const { PipelineRunRepository } = await import('../../src/infrastructure/db/pipeline-run.repository.js');
const { getDb } = await import('../../src/infrastructure/db/connection.js');

function makeAgentResult(overrides: Partial<AgentRunResult>): AgentRunResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

function makeJob(overrides: Partial<ExistingJobPayload> = {}): ExistingJobPayload {
  return {
    jobId: 'job-1',
    ticketId: 'ticket-uuid-1',
    ticketKey: `CAF-INSTR-${Math.random().toString(36).slice(2, 8)}`,
    ticketTitle: 'Instrumentation test ticket',
    ticketDescription: 'Test description',
    projectConfig: {
      repoCloneUrl: 'https://github.com/ganjardbc/umkm-pos.git',
      baseBranch: 'main',
      workspaceDir: '/tmp/caf-orchestrator/workspace/umkm-pos',
      agents: { modelOverrides: {} },
    },
    ...overrides,
  };
}

describe('CAF-DASHBOARD-01 Task 3: pipeline_runs/agent_events instrumentation', () => {
  let gitService: IGitService;
  let workspaceManager: IWorkspaceManager;
  let agentRunner: IAgentRunner;
  let linearClient: ILinearClient;
  let vcsClient: IVcsClient;
  let notifier: INotifier;

  beforeEach(() => {
    vi.clearAllMocks();

    gitService = {
      clone: vi.fn().mockResolvedValue(undefined),
      createBranch: vi.fn().mockResolvedValue(undefined),
      commitAll: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockResolvedValue(undefined),
      getHeadCommit: vi.fn().mockResolvedValue('deadbeef'),
      preflightCleanup: vi.fn().mockResolvedValue({
        hadUncommittedChanges: false,
        branchBeforeReset: 'main',
        headCommitBeforeReset: 'deadbeef',
        statusBeforeReset: '',
      }),
      getWorkspaceStatus: vi.fn().mockResolvedValue({ hasUncommittedChanges: false, statusOutput: '' }),
      diffStat: vi.fn().mockResolvedValue(''),
      remoteBranchExists: vi.fn().mockResolvedValue(true),
    };

    recordGateFailureMock.mockResolvedValue(undefined);
    resetOrchestrationStateMock.mockResolvedValue(undefined);
    readOrchestrationStateMock.mockResolvedValue(undefined);
    incrementOrchestrationRetryCountMock.mockResolvedValue(1);

    workspaceManager = {
      createWorkspace: vi.fn().mockResolvedValue('/tmp/workspace-1'),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
      validatePath: vi.fn().mockReturnValue(true),
    };

    agentRunner = { run: vi.fn() };

    linearClient = {
      postComment: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };

    vcsClient = {
      createPullRequest: vi.fn().mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/1', number: 1 }),
      replyToReviewComment: vi.fn().mockResolvedValue(undefined),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
      createPullRequestReview: vi.fn().mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/1#review-1', id: 1 }),
      findOpenPullRequestByHead: vi.fn().mockResolvedValue(undefined),
      updatePullRequest: vi.fn().mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/1', number: 1 }),
    };

    notifier = {
      notifyPipelineStarted: vi.fn().mockResolvedValue(undefined),
      notifyPipelineComplete: vi.fn().mockResolvedValue(undefined),
      notifyPipelineFailed: vi.fn().mockResolvedValue(undefined),
      notifyPipelineNeedsHuman: vi.fn().mockResolvedValue(undefined),
      notifyAgentSkipped: vi.fn().mockResolvedValue(undefined),
      notifyAgentStarted: vi.fn().mockResolvedValue(undefined),
    };

    readTasksMock.mockResolvedValue('# Tasks\n## Backend Tasks\n- do the thing\n');
    routeTasksMock.mockReturnValue(['caf-backend']);
    hasDocsTasksMock.mockReturnValue(false);
    parseSkipDirectivesMock.mockReturnValue(new Map());
    appendSkipNoteMock.mockResolvedValue(undefined);
    readVerifyReportMock.mockResolvedValue({ status: 'SUCCESS', raw: 'SUCCESS: all good' });
    readQaReportMock.mockResolvedValue({ status: 'PASS', raw: 'PASS: all good' });
    readReviewerReportMock.mockResolvedValue({ verdict: 'APPROVE', raw: '## Verdict: APPROVE' });
  });

  it('records agent_events in real spawn order with cost parsed from stdout, and finalizes pipeline_runs as SUCCESS', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation((agentName: string) => {
      if (agentName === 'caf-planner') {
        return Promise.resolve(
          makeAgentResult({ stdout: JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }) }),
        );
      }
      return Promise.resolve(makeAgentResult({ stdout: JSON.stringify({ total_cost_usd: 0.02 }) }));
    });

    const job = makeJob();
    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(job);

    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).not.toHaveBeenCalled();
    // No DB failures expected here — db.path points at a real writable file.
    expect(loggerWarnMock).not.toHaveBeenCalled();

    const repo = new PipelineRunRepository(getDb());
    const detail = repo.getPipelineDetail('ganjardbc/umkm-pos', job.ticketKey);
    expect(detail).toBeDefined();
    expect(detail?.run.finalStatus).toBe('SUCCESS');
    expect(detail?.run.endedAt).not.toBeNull();

    expect(detail?.events.map((e) => [e.agentName, e.pivPhase, e.eventType])).toEqual([
      ['caf-planner', 'plan', 'start'],
      ['caf-planner', 'plan', 'end'],
      ['caf-backend', 'implement', 'start'],
      ['caf-backend', 'implement', 'end'],
      ['caf-qa', 'verify', 'start'],
      ['caf-qa', 'verify', 'end'],
      ['caf-reviewer', 'verify', 'start'],
      ['caf-reviewer', 'verify', 'end'],
    ]);

    const plannerEnd = detail?.events.find((e) => e.agentName === 'caf-planner' && e.eventType === 'end');
    expect(plannerEnd?.costUsd).toBe(0.01);
  });

  it('records a retry event when QA fails once then passes', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({}));
    readQaReportMock
      .mockResolvedValueOnce({ status: 'FAIL', raw: 'FAIL: bug found' })
      .mockResolvedValueOnce({ status: 'PASS', raw: 'PASS: all good' });

    const job = makeJob();
    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(job);

    const repo = new PipelineRunRepository(getDb());
    const detail = repo.getPipelineDetail('ganjardbc/umkm-pos', job.ticketKey);
    const retryEvents = detail?.events.filter((e) => e.eventType === 'retry');
    expect(retryEvents).toEqual([
      expect.objectContaining({ agentName: 'caf-qa', pivPhase: 'verify', retryCount: 1 }),
    ]);
  });

  it('records a gate_exhausted event and finalizes pipeline_runs as NEEDS_HUMAN when QA keeps failing', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({}));
    readQaReportMock.mockResolvedValue({ status: 'FAIL', raw: 'FAIL: still broken' });

    const job = makeJob();
    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(job);

    const repo = new PipelineRunRepository(getDb());
    const detail = repo.getPipelineDetail('ganjardbc/umkm-pos', job.ticketKey);
    expect(detail?.run.finalStatus).toBe('NEEDS_HUMAN');
    expect(detail?.events.some((e) => e.eventType === 'gate_exhausted' && e.agentName === 'caf-qa')).toBe(true);
  });
  describe('CAF-DASHBOARD-02 T1', () => {
    it('records attempt 1, an OK outcome on every end event, and the PR number on success', async () => {
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({}));
      (vcsClient.createPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/77', number: 77 });

      const job = makeJob();
      const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
      await useCase.execute(job);

      const detail = new PipelineRunRepository(getDb()).getPipelineDetail('ganjardbc/umkm-pos', job.ticketKey);
      expect(detail?.run).toMatchObject({ finalStatus: 'SUCCESS', attempt: 1, prNumber: 77 });
      expect(detail?.events.every((e) => e.attempt === 1)).toBe(true);
      const ends = detail?.events.filter((e) => e.eventType === 'end') ?? [];
      expect(ends).toHaveLength(4);
      expect(ends.every((e) => e.outcome === 'OK' && e.exitCode === 0)).toBe(true);
      // No verify-report.md on disk in this test workspace — details degrade to null, nothing is logged.
      expect(ends.every((e) => e.verifyDetails === null)).toBe(true);
      expect(loggerWarnMock).not.toHaveBeenCalled();
    });

    it('records the Draft PR number when a gate stops the run', async () => {
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({}));
      readQaReportMock.mockResolvedValue({ status: 'FAIL', raw: 'FAIL: still broken' });
      (vcsClient.createPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/78', number: 78 });

      const job = makeJob();
      const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
      await useCase.execute(job);

      const detail = new PipelineRunRepository(getDb()).getPipelineDetail('ganjardbc/umkm-pos', job.ticketKey);
      expect(detail?.run).toMatchObject({ finalStatus: 'NEEDS_HUMAN', prNumber: 78 });
    });

    it('records a FAILED outcome with its exit code, finalizes ERROR, and marks the BullMQ re-run as attempt 2', async () => {
      (agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation((agentName: string) =>
        Promise.resolve(makeAgentResult(agentName === 'caf-backend' ? { exitCode: 2, stderr: 'boom' } : {})),
      );

      const job = makeJob();
      const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
      await expect(useCase.execute(job)).rejects.toThrow(/exited with code 2/);

      const repo = new PipelineRunRepository(getDb());
      const failed = repo.getPipelineDetail('ganjardbc/umkm-pos', job.ticketKey);
      expect(failed?.run).toMatchObject({ finalStatus: 'ERROR', attempt: 1 });
      expect(failed?.events.at(-1)).toMatchObject({ agentName: 'caf-backend', eventType: 'end', outcome: 'FAILED', exitCode: 2 });

      // The same job again, as BullMQ would re-deliver it.
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({}));
      await useCase.execute(job);

      const rerun = repo.getPipelineDetail('ganjardbc/umkm-pos', job.ticketKey);
      expect(rerun?.run).toMatchObject({ finalStatus: 'SUCCESS', attempt: 2 });
      expect(rerun?.events.filter((e) => e.attempt === 1)).toHaveLength(4);
      expect(rerun?.events.filter((e) => e.attempt === 2)).toHaveLength(8);
    });

    it('classifies a timeout and a kill signal distinctly from a non-zero exit', async () => {
      const { outcomeOf } = await import('../../src/infrastructure/db/pipeline-instrumentation.js');
      expect(outcomeOf({ exitCode: 0, signal: null, timedOut: false })).toBe('OK');
      expect(outcomeOf({ exitCode: 1, signal: null, timedOut: false })).toBe('FAILED');
      expect(outcomeOf({ exitCode: null, signal: 'SIGKILL', timedOut: false })).toBe('KILLED');
      expect(outcomeOf({ exitCode: null, signal: 'SIGTERM', timedOut: true })).toBe('TIMEOUT');
    });
  });
});
