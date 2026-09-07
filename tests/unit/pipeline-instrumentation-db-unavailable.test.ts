import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IGitService, IWorkspaceManager } from '../../src/domain/interfaces/git.interface.js';
import type { IAgentRunner, AgentRunResult } from '../../src/domain/interfaces/agent-runner.interface.js';
import type { ILinearClient } from '../../src/domain/interfaces/linear-client.interface.js';
import type { INotifier } from '../../src/domain/interfaces/notifier.interface.js';
import type { IVcsClient } from '../../src/domain/interfaces/vcs-client.interface.js';
import type { ExistingJobPayload } from '../../src/domain/interfaces/queue.interface.js';

// CAF-DASHBOARD-01 Task 3 verify: "simulasikan DB unavailable, pastikan pipeline
// tetap jalan normal" — db.path is pointed at a location that can never be
// opened (a regular file used as a directory segment, so mkdirSync always
// throws ENOTDIR), and every DB write for the whole run therefore fails.
// The pipeline must still complete normally, logging warnings only.

const tmpDir = mkdtempSync(join(tmpdir(), 'caf-dashboard-01-dbfail-'));
const blockerFile = join(tmpDir, 'not-a-directory');
writeFileSync(blockerFile, 'x');
const unusableDbPath = join(blockerFile, 'sub', 'test.sqlite');
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
  incrementOrchestrationRetryCount: incrementOrchestrationRetryCountMock,
}));

const configMock = {
  AGENT_SKIP_ENABLED: false,
  agents: { qa: { maxRetries: 1 }, reviewer: { maxRetries: 1 } },
  db: { path: unusableDbPath },
};
vi.mock('../../src/config/index.js', () => ({ config: configMock }));

const { RunAgentPipelineUseCase } = await import(
  '../../src/application/use-cases/run-agent-pipeline.use-case.js'
);

function makeAgentResult(overrides: Partial<AgentRunResult>): AgentRunResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

function makeJob(overrides: Partial<ExistingJobPayload> = {}): ExistingJobPayload {
  return {
    jobId: 'job-1',
    ticketId: 'ticket-uuid-1',
    ticketKey: 'CAF-DBFAIL-1',
    ticketTitle: 'DB-unavailable test ticket',
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

describe('CAF-DASHBOARD-01 Task 3: pipeline runs normally when the history DB is unavailable', () => {
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

    agentRunner = { run: vi.fn().mockResolvedValue(makeAgentResult({})) };

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

  it('completes the pipeline successfully even though every history-DB write fails', async () => {
    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    // The actual pipeline outcome is unaffected by the DB being unreachable.
    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineFailed).not.toHaveBeenCalled();
    expect(gitService.push).toHaveBeenCalledTimes(1);
    expect(vcsClient.createPullRequest).toHaveBeenCalledTimes(1);

    // DB failures are logged as warnings, never as errors, and never thrown.
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(loggerWarnMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of loggerWarnMock.mock.calls) {
      expect(call[0]).toMatch(/Pipeline-history DB write failed/);
    }
  });
});
