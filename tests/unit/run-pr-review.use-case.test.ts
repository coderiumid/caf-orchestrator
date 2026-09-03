import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IGitService, IWorkspaceManager } from '../../src/domain/interfaces/git.interface.js';
import type { IAgentRunner, AgentRunResult } from '../../src/domain/interfaces/agent-runner.interface.js';
import type { IVcsClient } from '../../src/domain/interfaces/vcs-client.interface.js';
import type { PrReviewJobPayload } from '../../src/domain/interfaces/queue.interface.js';
import type { FixReviewLog } from '../../src/infrastructure/reports/report-reader.js';

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

const readFixReviewLogMock = vi.fn();
vi.mock('../../src/infrastructure/reports/report-reader.js', () => ({
  readFixReviewLog: readFixReviewLogMock,
}));

const { RunPrReviewUseCase } = await import('../../src/application/use-cases/run-pr-review.use-case.js');

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

function makeJob(overrides: Partial<PrReviewJobPayload> = {}): PrReviewJobPayload {
  return {
    jobId: 'job-1',
    repoFullName: 'ganjardbc/umkm-pos',
    cloneUrl: 'https://github.com/ganjardbc/umkm-pos.git',
    prNumber: 42,
    prHeadBranch: 'ai-agent/CAF-123',
    mode: 'initial',
    commentContext: [],
    ...overrides,
  };
}

function makeFixReviewLog(overrides: Partial<FixReviewLog> = {}): FixReviewLog {
  return {
    mode: undefined,
    entries: [],
    raw: '',
    ...overrides,
  };
}

describe('RunPrReviewUseCase', () => {
  let gitService: IGitService;
  let workspaceManager: IWorkspaceManager;
  let agentRunner: IAgentRunner;
  let vcsClient: IVcsClient;

  beforeEach(() => {
    vi.clearAllMocks();

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

    agentRunner = { run: vi.fn() };

    vcsClient = {
      createPullRequest: vi.fn().mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/42', number: 42 }),
      replyToReviewComment: vi.fn().mockResolvedValue(undefined),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('runs the reviewer agent, replies to INLINE comments, and posts a summary comment', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readFixReviewLogMock.mockResolvedValue(
      makeFixReviewLog({
        entries: [
          { commentRef: '123', label: 'INLINE', path: 'src/foo.ts', line: 10, status: 'FIXED', note: 'done' },
          { commentRef: '456', label: 'GENERAL', status: 'SKIPPED', note: 'not applicable' },
        ],
      }),
    );

    const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });
    await useCase.execute(makeJob());

    // CAF-WSMODE-01: PR-review jobs always pass workspacePurpose: 'pr-review',
    // so persistent-mode reuse (config.workspace.mode: 'persistent') never
    // applies here regardless of the global config value.
    expect(workspaceManager.createWorkspace).toHaveBeenCalledWith(undefined, 'pr-review');
    expect(gitService.clone).toHaveBeenCalledWith(
      'https://github.com/ganjardbc/umkm-pos.git',
      'ai-agent/CAF-123',
      '/tmp/workspace-1/repo',
    );
    expect(agentRunner.run).toHaveBeenCalledWith('caf-reviewer', '/tmp/workspace-1/repo', expect.any(String));
    expect(vcsClient.replyToReviewComment).toHaveBeenCalledTimes(1);
    expect(vcsClient.replyToReviewComment).toHaveBeenCalledWith({
      owner: 'ganjardbc',
      repo: 'umkm-pos',
      prNumber: 42,
      commentId: 123,
      body: 'FIXED — done',
    });
    expect(vcsClient.postIssueComment).toHaveBeenCalledTimes(1);
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledWith('/tmp/workspace-1', undefined, 'pr-review');
  });

  it('skips replying to a GENERAL entry (no comment to reply to)', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readFixReviewLogMock.mockResolvedValue(
      makeFixReviewLog({ entries: [{ commentRef: '789', label: 'GENERAL', status: 'FIXED', note: '' }] }),
    );

    const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });
    await useCase.execute(makeJob());

    expect(vcsClient.replyToReviewComment).not.toHaveBeenCalled();
    expect(vcsClient.postIssueComment).toHaveBeenCalledTimes(1);
  });

  it('skips replying to an INLINE entry with a non-numeric commentRef, logs a warning, still posts summary', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readFixReviewLogMock.mockResolvedValue(
      makeFixReviewLog({
        entries: [{ commentRef: 'not-a-number', label: 'INLINE', path: 'a.ts', line: 1, status: 'FIXED', note: '' }],
      }),
    );

    const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });
    await useCase.execute(makeJob());

    expect(vcsClient.replyToReviewComment).not.toHaveBeenCalled();
    expect(vcsClient.postIssueComment).toHaveBeenCalledTimes(1);
  });

  it('rejects a PR head branch that does not match ai-agent/{TICKET-ID} without creating a workspace', async () => {
    const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });

    await expect(useCase.execute(makeJob({ prHeadBranch: 'main' }))).rejects.toThrow(
      /does not match ai-agent/,
    );
    expect(workspaceManager.createWorkspace).not.toHaveBeenCalled();
    expect(gitService.clone).not.toHaveBeenCalled();
  });

  it('throws and cleans up the workspace when the reviewer agent is killed by signal', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({ exitCode: null, signal: 'SIGKILL', timedOut: true }),
    );

    const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });

    await expect(useCase.execute(makeJob())).rejects.toThrow(/killed by signal SIGKILL/);
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(vcsClient.postIssueComment).not.toHaveBeenCalled();
  });

  it('throws when the reviewer agent exits non-zero', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgentResult({ exitCode: 1, stderr: 'boom' }),
    );

    const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });

    await expect(useCase.execute(makeJob())).rejects.toThrow(/exited with code 1/);
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledTimes(1);
  });

  it('throws when the reviewer agent does not produce a fix-review-log.md', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readFixReviewLogMock.mockResolvedValue(undefined);

    const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });

    await expect(useCase.execute(makeJob())).rejects.toThrow(/No fix-review-log.md produced/);
    expect(workspaceManager.cleanupWorkspace).toHaveBeenCalledTimes(1);
  });

  it('includes commentContext in the reviewer prompt for a scoped/global fix-review mode', async () => {
    (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
    readFixReviewLogMock.mockResolvedValue(makeFixReviewLog());

    const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });
    await useCase.execute(
      makeJob({
        mode: 'scoped',
        commentContext: [{ id: 999, label: 'GENERAL', body: 'please fix the typo' }],
      }),
    );

    const prompt = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(prompt).toContain('Comment ID: 999');
    expect(prompt).toContain('please fix the typo');
    expect(prompt).toContain('Mode: scoped');
  });
});
