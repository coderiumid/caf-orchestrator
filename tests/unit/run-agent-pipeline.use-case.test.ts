import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IGitService, IWorkspaceManager } from '../../src/domain/interfaces/git.interface.js';
import type { IAgentRunner, AgentRunResult } from '../../src/domain/interfaces/agent-runner.interface.js';
import type { ILinearClient } from '../../src/domain/interfaces/linear-client.interface.js';
import type { INotifier } from '../../src/domain/interfaces/notifier.interface.js';
import type { IVcsClient } from '../../src/domain/interfaces/vcs-client.interface.js';
import type { ExistingJobPayload } from '../../src/domain/interfaces/queue.interface.js';

const loggerErrorMock = vi.fn();
vi.mock('../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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
}));

// AGENT_SKIP_ENABLED defaults false to match the real schema default — tests
// that need the flag on set configMock.AGENT_SKIP_ENABLED = true directly;
// beforeEach below resets it to false for every test regardless.
// agents.qa/reviewer.maxRetries mirror the real caf.config.yaml used in this
// repo (both 1) so existing retry-count assertions stay valid unmocked.
const configMock = {
  AGENT_SKIP_ENABLED: false,
  agents: {
    qa: { maxRetries: 1 },
    reviewer: { maxRetries: 1 },
  },
};
vi.mock('../../src/config/index.js', () => ({ config: configMock }));

const { RunAgentPipelineUseCase } = await import(
  '../../src/application/use-cases/run-agent-pipeline.use-case.js'
);

function makeAgentResult(overrides: Partial<AgentRunResult>): AgentRunResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

function makeJob(overrides: Partial<ExistingJobPayload> = {}): ExistingJobPayload {
  return {
    jobId: 'job-1',
    ticketId: 'ticket-uuid-1',
    ticketKey: 'CAF-123',
    ticketTitle: 'Test ticket',
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

describe('RunAgentPipelineUseCase', () => {
  let gitService: IGitService;
  let workspaceManager: IWorkspaceManager;
  let agentRunner: IAgentRunner;
  let linearClient: ILinearClient;
  let vcsClient: IVcsClient;
  let notifier: INotifier;

  beforeEach(() => {
    vi.clearAllMocks();
    configMock.AGENT_SKIP_ENABLED = false;
    configMock.agents.qa.maxRetries = 1;
    configMock.agents.reviewer.maxRetries = 1;

    gitService = {
      clone: vi.fn().mockResolvedValue(undefined),
      createBranch: vi.fn().mockResolvedValue(undefined),
      commitAll: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockResolvedValue(undefined),
    };

    workspaceManager = {
      createWorkspace: vi.fn().mockResolvedValue('/tmp/workspace-1'),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
      validatePath: vi.fn().mockReturnValue(true),
    };

    agentRunner = {
      run: vi.fn(),
    };

    linearClient = {
      postComment: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };

    vcsClient = {
      createPullRequest: vi.fn().mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/1', number: 1 }),
      replyToReviewComment: vi.fn().mockResolvedValue(undefined),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
      createPullRequestReview: vi.fn().mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/1#review-1', id: 1 }),
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

  it('completes the pipeline when every agent exits 0 (success path)', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({ exitCode: 0 }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(gitService.push).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineFailed).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('notifies notifyAgentStarted for every agent stage that actually runs (planner, backend, qa, reviewer)', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({ exitCode: 0 }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    const startedAgentNames = (notifier.notifyAgentStarted as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].agentName,
    );
    expect(startedAgentNames).toEqual(['caf-planner', 'caf-backend', 'caf-qa', 'caf-reviewer']);
    expect(notifier.notifyAgentStarted).toHaveBeenCalledWith({
      jobId: 'job-1',
      ticketKey: 'CAF-123',
      agentName: 'caf-planner',
    });
  });

  it('fires notifyAgentStarted again for each implementation retry (use-case does not itself throttle — that is the notifier adapter\'s job)', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readQaReportMock
      .mockResolvedValueOnce({ status: 'FAIL', raw: 'FAIL: bug found' })
      .mockResolvedValueOnce({ status: 'PASS', raw: 'PASS: all good' });

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    const backendStartedCalls = (notifier.notifyAgentStarted as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0].agentName === 'caf-backend',
    );
    const qaStartedCalls = (notifier.notifyAgentStarted as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0].agentName === 'caf-qa',
    );
    expect(backendStartedCalls).toHaveLength(2);
    expect(qaStartedCalls).toHaveLength(2);
  });

  it('notifies notifyAgentStarted for documentation when Docs Tasks is non-empty', async () => {
    hasDocsTasksMock.mockReturnValue(true);
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(notifier.notifyAgentStarted).toHaveBeenCalledWith({
      jobId: 'job-1',
      ticketKey: 'CAF-123',
      agentName: 'caf-documentation',
    });
  });

  it('does not block or fail the pipeline when notifyAgentStarted rejects', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    (notifier.notifyAgentStarted as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('telegram down'));

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
  });

  it('logs full stdout/stderr and fails the job when an agent exits non-zero', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({
        exitCode: 1,
        stdout: 'planner stdout: analyzed ticket, about to write tasks.md',
        stderr: 'planner stderr: failed to write file',
      }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });

    await expect(useCase.execute(makeJob())).rejects.toThrow(/exited with code 1/);

    const failureLogCall = loggerErrorMock.mock.calls.find(
      (call) => call[0] === 'caf-planner agent run failed',
    );
    expect(failureLogCall).toBeDefined();
    const fields = failureLogCall?.[2];
    expect(fields).toMatchObject({
      exitCode: 1,
      stdout: 'planner stdout: analyzed ticket, about to write tasks.md',
      stderr: 'planner stderr: failed to write file',
    });

    expect(notifier.notifyPipelineFailed).toHaveBeenCalledTimes(1);
    expect(gitService.commitAll).not.toHaveBeenCalled();
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledTimes(1);
  });

  it('logs the signal and fails the job when the agent process is killed', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({
        exitCode: null,
        signal: 'SIGKILL',
        stdout: 'partial planner output before kill',
        stderr: '',
        timedOut: true,
      }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });

    await expect(useCase.execute(makeJob())).rejects.toThrow(/killed by signal SIGKILL/);

    const failureLogCall = loggerErrorMock.mock.calls.find(
      (call) => (call[2] as { signal?: string } | undefined)?.signal === 'SIGKILL',
    );
    expect(failureLogCall).toBeDefined();
    expect(failureLogCall?.[2]).toMatchObject({
      signal: 'SIGKILL',
      timedOut: true,
      stdout: 'partial planner output before kill',
    });

    expect(notifier.notifyPipelineFailed).toHaveBeenCalledTimes(1);
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledTimes(1);
  });

  it('stops cleanly (no throw, comment posted) when the planner hits a 429 quota error', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({
        exitCode: 1,
        stdout: JSON.stringify({ is_error: true, api_error_status: 429, quotaResetDelay: 120_000 }),
        stderr: 'rate limited',
      }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('planner agent hit API quota'),
    );
    expect(notifier.notifyPipelineFailed).not.toHaveBeenCalled();
    expect(notifier.notifyPipelineComplete).not.toHaveBeenCalled();
    expect(gitService.commitAll).not.toHaveBeenCalled();
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineNeedsHuman).toHaveBeenCalledTimes(1);
  });

  it('stops cleanly on a 429 from the QA gate instead of retrying implementation agents', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(async (agentName: string) =>
      agentName === 'caf-qa'
        ? makeAgentResult({
            exitCode: 1,
            stdout: JSON.stringify({ is_error: true, api_error_status: 429 }),
            stderr: 'rate limited',
          })
        : makeAgentResult({ exitCode: 0 }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    const backendCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-backend',
    );
    expect(backendCalls).toHaveLength(1); // no implementation retry triggered by the 429
    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('qa agent hit API quota'),
    );
    expect(notifier.notifyPipelineFailed).not.toHaveBeenCalled();
    expect(gitService.commitAll).not.toHaveBeenCalled();
    expect(notifier.notifyPipelineNeedsHuman).toHaveBeenCalledTimes(1);
  });

  it('stops cleanly (no throw, comment posted) when the planner hits a 404 model-not-found error', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({
        exitCode: 1,
        stdout: JSON.stringify({ is_error: true, api_error_status: 404 }),
        stderr: 'model not found',
      }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('model tidak ditemukan'),
    );
    expect(notifier.notifyPipelineFailed).not.toHaveBeenCalled();
    expect(notifier.notifyPipelineComplete).not.toHaveBeenCalled();
    expect(gitService.commitAll).not.toHaveBeenCalled();
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineNeedsHuman).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generic throw (BullMQ retry) on an unrecognized status like 500 — not treated as non-retryable', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({
        exitCode: 1,
        stdout: JSON.stringify({ is_error: true, api_error_status: 500 }),
        stderr: 'internal server error',
      }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });

    await expect(useCase.execute(makeJob())).rejects.toThrow(/exited with code 1/);
    expect(linearClient.postComment).not.toHaveBeenCalled();
    expect(notifier.notifyPipelineFailed).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generic throw when stdout is a non-JSON 500-style failure', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({
        exitCode: 1,
        stdout: 'planner stdout: analyzed ticket, about to write tasks.md',
        stderr: 'planner stderr: failed to write file',
      }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });

    await expect(useCase.execute(makeJob())).rejects.toThrow(/exited with code 1/);
    expect(linearClient.postComment).not.toHaveBeenCalled();
    expect(notifier.notifyPipelineFailed).toHaveBeenCalledTimes(1);
  });

  it('runs the documentation agent and notes success when Docs Tasks is non-empty', async () => {
    hasDocsTasksMock.mockReturnValue(true);
    (agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      makeAgentResult({ exitCode: 0 }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(agentRunner.run).toHaveBeenCalledWith(
      'caf-documentation',
      expect.any(String),
      expect.stringContaining('Docs Tasks'),
      undefined,
    );
    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(gitService.push).toHaveBeenCalledTimes(1);
    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Documentation agent updated docs'),
    );
    expect(notifier.notifyPipelineFailed).not.toHaveBeenCalled();
  });

  it('never invokes the documentation agent when Docs Tasks is absent/(none)', async () => {
    hasDocsTasksMock.mockReturnValue(false);
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({ exitCode: 0 }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(agentRunner.run).not.toHaveBeenCalledWith('caf-documentation', expect.anything(), expect.anything());
    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('No Docs Tasks in tasks.md'),
    );
  });

  it('does not fail the pipeline when the documentation agent exits non-zero', async () => {
    hasDocsTasksMock.mockReturnValue(true);
    (agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(async (agentName: string) =>
      agentName === 'caf-documentation'
        ? makeAgentResult({ exitCode: 1, stderr: 'docs agent failed' })
        : makeAgentResult({ exitCode: 0 }),
    );

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(gitService.push).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineFailed).not.toHaveBeenCalled();
    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('docs need manual update'),
    );
  });

  it('does not fail the pipeline when the documentation agent runner throws', async () => {
    hasDocsTasksMock.mockReturnValue(true);
    (agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(async (agentName: string) => {
      if (agentName === 'caf-documentation') {
        throw new Error('spawn failed');
      }
      return makeAgentResult({ exitCode: 0 });
    });

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(gitService.push).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineFailed).not.toHaveBeenCalled();
    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('docs need manual update'),
    );
  });

  it('stops on verify-report NEEDS_HUMAN before QA is ever spawned', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readVerifyReportMock.mockResolvedValue({ status: 'NEEDS_HUMAN', raw: 'NEEDS_HUMAN: manual check required' });

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(agentRunner.run).not.toHaveBeenCalledWith('caf-qa', expect.anything(), expect.anything());
    expect(readQaReportMock).not.toHaveBeenCalled();
    expect(gitService.commitAll).not.toHaveBeenCalled();
    expect(gitService.push).not.toHaveBeenCalled();
    expect(notifier.notifyPipelineComplete).not.toHaveBeenCalled();
    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('needs human review'),
    );
    expect(notifier.notifyPipelineNeedsHuman).toHaveBeenCalledTimes(1);
  });

  it('posts the NEEDS_HUMAN comment to the GitHub issue instead of Linear when ticketSource is github', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readVerifyReportMock.mockResolvedValue({ status: 'NEEDS_HUMAN', raw: 'NEEDS_HUMAN: manual check required' });

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob({
      ticketId: '25',
      ticketKey: 'CDR-25',
      ticketSource: 'github',
      projectConfig: {
        repoCloneUrl: 'https://github.com/ganjardbc/coderium-web-v2.git',
        baseBranch: 'main',
        workspaceDir: '/tmp/caf-orchestrator/workspace/coderium-web-v2',
        agents: { modelOverrides: {} },
      },
    }));

    expect(linearClient.postComment).not.toHaveBeenCalled();
    expect(vcsClient.postIssueComment).toHaveBeenCalledWith({
      owner: 'ganjardbc',
      repo: 'coderium-web-v2',
      issueNumber: 25,
      body: expect.stringContaining('needs human review'),
    });
  });

  it('retries implementation agents once when QA fails, then completes on QA pass', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readQaReportMock
      .mockResolvedValueOnce({ status: 'FAIL', raw: 'FAIL: bug found' })
      .mockResolvedValueOnce({ status: 'PASS', raw: 'PASS: all good' });

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    const backendCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-backend',
    );
    const qaCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === 'caf-qa');
    expect(backendCalls).toHaveLength(2);
    expect(qaCalls).toHaveLength(2);
    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(gitService.push).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('PASS: all good'),
    );
  });

  it('stops with NEEDS_HUMAN comment when QA fails twice (initial + 1 retry)', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readQaReportMock.mockResolvedValue({ status: 'FAIL', raw: 'FAIL: still broken' });

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    const backendCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-backend',
    );
    const qaCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === 'caf-qa');
    const docsCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-documentation',
    );
    expect(backendCalls).toHaveLength(2);
    expect(qaCalls).toHaveLength(2);
    expect(docsCalls).toHaveLength(0);
    expect(gitService.commitAll).not.toHaveBeenCalled();
    expect(gitService.push).not.toHaveBeenCalled();
    expect(notifier.notifyPipelineComplete).not.toHaveBeenCalled();
    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('needs human review (QA failed after retry)'),
    );
    expect(notifier.notifyPipelineNeedsHuman).toHaveBeenCalledTimes(1);
  });

  it('throws when qa-report.md is not produced', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readQaReportMock.mockResolvedValue(undefined);

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });

    await expect(useCase.execute(makeJob())).rejects.toThrow(/No qa-report.md produced/);
    expect(notifier.notifyPipelineFailed).toHaveBeenCalledTimes(1);
  });

  it('completes the pipeline when reviewer approves on first try', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    const reviewerCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-reviewer',
    );
    const backendCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-backend',
    );
    expect(reviewerCalls).toHaveLength(1);
    expect(backendCalls).toHaveLength(1);
    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(gitService.push).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
  });

  it('completes the pipeline when reviewer defers on first try (no retry)', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readReviewerReportMock.mockResolvedValue({ verdict: 'DEFER', raw: '## Verdict: DEFER' });

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    const reviewerCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-reviewer',
    );
    const backendCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-backend',
    );
    expect(reviewerCalls).toHaveLength(1);
    expect(backendCalls).toHaveLength(1);
    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(gitService.push).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
  });

  it('retries implementation agents once when reviewer requests changes, then completes on approve (no extra QA run)', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readReviewerReportMock
      .mockResolvedValueOnce({ verdict: 'CHANGES_REQUESTED', raw: '## Verdict: CHANGES REQUESTED' })
      .mockResolvedValueOnce({ verdict: 'APPROVE', raw: '## Verdict: APPROVE' });

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    const reviewerCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-reviewer',
    );
    const backendCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-backend',
    );
    const qaCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === 'caf-qa');
    expect(reviewerCalls).toHaveLength(2);
    expect(backendCalls).toHaveLength(2);
    expect(qaCalls).toHaveLength(1);
    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(gitService.push).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
  });

  it('stops with NEEDS_HUMAN comment when reviewer requests changes twice (initial + 1 retry)', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readReviewerReportMock.mockResolvedValue({ verdict: 'CHANGES_REQUESTED', raw: '## Verdict: CHANGES REQUESTED' });

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    const reviewerCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-reviewer',
    );
    const backendCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-backend',
    );
    const qaCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === 'caf-qa');
    const docsCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'caf-documentation',
    );
    expect(reviewerCalls).toHaveLength(2);
    expect(backendCalls).toHaveLength(2);
    expect(qaCalls).toHaveLength(1);
    expect(docsCalls).toHaveLength(0);
    expect(gitService.commitAll).not.toHaveBeenCalled();
    expect(gitService.push).not.toHaveBeenCalled();
    expect(notifier.notifyPipelineComplete).not.toHaveBeenCalled();
    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('needs human review (reviewer requested changes after retry)'),
    );
    expect(notifier.notifyPipelineNeedsHuman).toHaveBeenCalledTimes(1);
  });

  it('throws when review-notes.md is not produced', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readReviewerReportMock.mockResolvedValue(undefined);

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });

    await expect(useCase.execute(makeJob())).rejects.toThrow(/No review-notes.md produced/);
    expect(notifier.notifyPipelineFailed).toHaveBeenCalledTimes(1);
  });

  it('creates a pull request after push and includes its URL in the final Linear comment', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    (vcsClient.createPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      url: 'https://github.com/ganjardbc/umkm-pos/pull/42',
      number: 42,
    });

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(vcsClient.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'ganjardbc',
        repo: 'umkm-pos',
        head: 'ai-agent/CAF-123',
        base: 'main',
      }),
    );
    expect(linearClient.postComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('https://github.com/ganjardbc/umkm-pos/pull/42'),
    );
    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineFailed).not.toHaveBeenCalled();
  });

  it('fails the job with no partial success state when pull request creation throws', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    (vcsClient.createPullRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('GitHub API request failed (422)'));

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });

    await expect(useCase.execute(makeJob())).rejects.toThrow(/GitHub API request failed/);

    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(gitService.push).toHaveBeenCalledTimes(1);
    expect(linearClient.postComment).not.toHaveBeenCalled();
    expect(notifier.notifyPipelineComplete).not.toHaveBeenCalled();
    expect(notifier.notifyPipelineFailed).toHaveBeenCalledTimes(1);
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledTimes(1);
  });

  it('calls notifyPipelineStarted with correct data before the planner agent is spawned', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    const callOrder: string[] = [];
    (notifier.notifyPipelineStarted as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('notifyPipelineStarted');
    });
    (agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(async (agentName: string) => {
      callOrder.push(`agentRunner.run:${agentName}`);
      return makeAgentResult({ exitCode: 0 });
    });

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(notifier.notifyPipelineStarted).toHaveBeenCalledWith({
      jobId: 'job-1',
      ticketKey: 'CAF-123',
      ticketTitle: 'Test ticket',
    });
    expect(callOrder[0]).toBe('notifyPipelineStarted');
    expect(callOrder.indexOf('notifyPipelineStarted')).toBeLessThan(callOrder.indexOf('agentRunner.run:caf-planner'));
  });

  it('does not block or fail the pipeline when notifyPipelineStarted rejects', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    (notifier.notifyPipelineStarted as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('telegram down'));

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
    await useCase.execute(makeJob());

    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(gitService.push).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
  });

  it('runs the pipeline normally when notifier is undefined', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));

    const useCase = new RunAgentPipelineUseCase({
      gitService,
      workspaceManager,
      agentRunner,
      linearClient,
      vcsClient,
      notifier: undefined,
    });

    await expect(useCase.execute(makeJob())).resolves.toBeUndefined();
    expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    expect(gitService.push).toHaveBeenCalledTimes(1);
  });

  describe('dynamic agent skip (AGENT_SKIP_ENABLED)', () => {
    it('runs every routed agent regardless of Planner skip marks when AGENT_SKIP_ENABLED is false (regression)', async () => {
      configMock.AGENT_SKIP_ENABLED = false;
      routeTasksMock.mockReturnValue(['caf-frontend', 'caf-backend']);
      parseSkipDirectivesMock.mockReturnValue(new Map([['caf-backend', 'should be ignored while flag is off']]));
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));

      const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
      await useCase.execute(makeJob());

      const backendCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === 'caf-backend');
      const frontendCalls = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === 'caf-frontend');
      expect(backendCalls).toHaveLength(1);
      expect(frontendCalls).toHaveLength(1);
      expect(parseSkipDirectivesMock).not.toHaveBeenCalled();
      expect(notifier.notifyAgentSkipped).not.toHaveBeenCalled();
      expect(routeTasksMock).toHaveBeenCalledWith(expect.any(String), { strictEmptyCheck: false });
      expect(appendSkipNoteMock).not.toHaveBeenCalled();
      expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    });

    it('skips the marked implementation agent, still runs the rest, and records the skip in verify-report.md', async () => {
      configMock.AGENT_SKIP_ENABLED = true;
      routeTasksMock.mockReturnValue(['caf-frontend', 'caf-backend']);
      parseSkipDirectivesMock.mockReturnValue(new Map([['caf-backend', 'no backend changes needed']]));
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));

      const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
      await useCase.execute(makeJob());

      expect(agentRunner.run).not.toHaveBeenCalledWith('caf-backend', expect.anything(), expect.anything());
      expect(agentRunner.run).toHaveBeenCalledWith('caf-frontend', expect.any(String), expect.any(String), undefined);
      expect(notifier.notifyAgentSkipped).toHaveBeenCalledWith({
        jobId: 'job-1',
        ticketKey: 'CAF-123',
        agentName: 'caf-backend',
        reason: 'no backend changes needed',
      });
      expect(appendSkipNoteMock).toHaveBeenCalledWith(
        expect.any(String),
        'CAF-123',
        expect.arrayContaining([expect.stringContaining('backend: SKIPPED — no backend changes needed')]),
      );
      expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    });

    it('never spawns every routed implementation agent even if the skip directives would cover all of them (safety net)', async () => {
      configMock.AGENT_SKIP_ENABLED = true;
      routeTasksMock.mockReturnValue(['caf-backend']);
      parseSkipDirectivesMock.mockReturnValue(new Map([['caf-backend', 'looks skippable but is the only section']]));
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));

      const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
      await useCase.execute(makeJob());

      expect(agentRunner.run).toHaveBeenCalledWith('caf-backend', expect.any(String), expect.any(String), undefined);
      expect(notifier.notifyAgentSkipped).not.toHaveBeenCalledWith(
        expect.objectContaining({ agentName: 'caf-backend' }),
      );
      expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    });

    it('skips the QA agent, notifies with an explicit "qa" mention, and injects a quality-gate warning into the PR body', async () => {
      configMock.AGENT_SKIP_ENABLED = true;
      parseSkipDirectivesMock.mockReturnValue(new Map([['qa', 'config-only ticket, nothing to test']]));
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));

      const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
      await useCase.execute(makeJob());

      expect(agentRunner.run).not.toHaveBeenCalledWith('caf-qa', expect.anything(), expect.anything());
      expect(readQaReportMock).not.toHaveBeenCalled();
      expect(notifier.notifyAgentSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ agentName: 'caf-qa', reason: 'config-only ticket, nothing to test' }),
      );
      expect(vcsClient.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Quality gate dilewati'),
        }),
      );
      expect(vcsClient.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('QA Agent tidak dijalankan'),
        }),
      );
      expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    });

    it('skips the Reviewer agent, notifies with an explicit "reviewer" mention, and injects a quality-gate warning into the PR body', async () => {
      configMock.AGENT_SKIP_ENABLED = true;
      parseSkipDirectivesMock.mockReturnValue(new Map([['reviewer', 'trivial one-line change']]));
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));

      const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
      await useCase.execute(makeJob());

      expect(agentRunner.run).not.toHaveBeenCalledWith('caf-reviewer', expect.anything(), expect.anything());
      expect(readReviewerReportMock).not.toHaveBeenCalled();
      expect(notifier.notifyAgentSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ agentName: 'caf-reviewer', reason: 'trivial one-line change' }),
      );
      expect(vcsClient.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Reviewer Agent tidak dijalankan'),
        }),
      );
      expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    });

    it('skips the documentation agent via directive even when Docs Tasks has real content', async () => {
      configMock.AGENT_SKIP_ENABLED = true;
      hasDocsTasksMock.mockReturnValue(true);
      parseSkipDirectivesMock.mockReturnValue(new Map([['documentation', 'docs already covered in a separate ticket']]));
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));

      const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
      await useCase.execute(makeJob());

      expect(agentRunner.run).not.toHaveBeenCalledWith('caf-documentation', expect.anything(), expect.anything());
      expect(notifier.notifyAgentSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ agentName: 'caf-documentation', reason: 'docs already covered in a separate ticket' }),
      );
      expect(appendSkipNoteMock).toHaveBeenCalledWith(
        expect.any(String),
        'CAF-123',
        expect.arrayContaining([expect.stringContaining('documentation: SKIPPED')]),
      );
      expect(linearClient.postComment).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Documentation agent skipped'),
      );
    });

    it('treats an empty/ambiguous skip-directive parse as "skip nothing" even with the flag on (fail-safe)', async () => {
      configMock.AGENT_SKIP_ENABLED = true;
      routeTasksMock.mockReturnValue(['caf-backend']);
      // Simulates parseSkipDirectives() having found no well-formed directive
      // (absent section, malformed lines, unrecognized agent names — see
      // task-router.test.ts for the parser-level fail-safe coverage).
      parseSkipDirectivesMock.mockReturnValue(new Map());
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));

      const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
      await useCase.execute(makeJob());

      expect(agentRunner.run).toHaveBeenCalledWith('caf-backend', expect.any(String), expect.any(String), undefined);
      expect(agentRunner.run).toHaveBeenCalledWith('caf-qa', expect.any(String), expect.any(String), undefined);
      expect(agentRunner.run).toHaveBeenCalledWith('caf-reviewer', expect.any(String), expect.any(String), undefined);
      expect(notifier.notifyAgentSkipped).not.toHaveBeenCalled();
      expect(appendSkipNoteMock).not.toHaveBeenCalled();
      expect(gitService.commitAll).toHaveBeenCalledTimes(1);
    });
  });
});
