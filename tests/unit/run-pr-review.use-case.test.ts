import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IGitService, IWorkspaceManager } from '../../src/domain/interfaces/git.interface.js';
import type { IAgentRunner, AgentRunResult } from '../../src/domain/interfaces/agent-runner.interface.js';
import type { IVcsClient } from '../../src/domain/interfaces/vcs-client.interface.js';
import type { PrReviewJobPayload } from '../../src/domain/interfaces/queue.interface.js';
import type { FixReviewLog, InitialReviewReport } from '../../src/infrastructure/reports/report-reader.js';
import { SelfReviewRejectedError } from '../../src/domain/errors/app-errors.js';

const loggerErrorMock = vi.fn();
const loggerInfoMock = vi.fn();
vi.mock('../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: loggerInfoMock,
    warn: vi.fn(),
    error: loggerErrorMock,
    fatal: vi.fn(),
    child: vi.fn(),
  },
}));

const readFixReviewLogMock = vi.fn();
const readInitialReviewReportMock = vi.fn();
vi.mock('../../src/infrastructure/reports/report-reader.js', () => ({
  readFixReviewLog: readFixReviewLogMock,
  readInitialReviewReport: readInitialReviewReportMock,
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

// Default mode is 'scoped' — the pre-existing fix-review-log contract these
// regression tests exercise. Mode 'initial' tests below override explicitly.
function makeJob(overrides: Partial<PrReviewJobPayload> = {}): PrReviewJobPayload {
  return {
    jobId: 'job-1',
    repoFullName: 'ganjardbc/umkm-pos',
    cloneUrl: 'https://github.com/ganjardbc/umkm-pos.git',
    prNumber: 42,
    prHeadBranch: 'ai-agent/CAF-123',
    mode: 'scoped',
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

function makeInitialReviewReport(overrides: Partial<InitialReviewReport> = {}): InitialReviewReport {
  return {
    verdict: 'APPROVE',
    raw: '## Review Notes — CAF-123\nVerdict: APPROVE\n',
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
      createPullRequestReview: vi.fn().mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/42#review-1', id: 1 }),
    };
  });

  describe('mode scoped/global — fix-review-log contract (regression, unchanged)', () => {
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
      expect(vcsClient.createPullRequestReview).not.toHaveBeenCalled();
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

    it('builds the identical prompt for mode global as for scoped, modulo the mode label (byte-for-byte fix-review contract)', async () => {
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
      readFixReviewLogMock.mockResolvedValue(makeFixReviewLog());

      const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });
      await useCase.execute(makeJob({ mode: 'global', commentContext: [] }));

      const prompt = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      expect(prompt).toContain('Mode: global');
      expect(prompt).toContain('tulis `.caf/tasks/CAF-123/fix-review-log.md` saja');
      expect(prompt).not.toContain('review-notes.md');
    });
  });

  describe('mode initial — real INITIAL (Verdict-producing) contract', () => {
    it('sends an INITIAL-mode prompt (empty commentContext, review-notes.md instructions) distinct from fix-review-log', async () => {
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
      readInitialReviewReportMock.mockResolvedValue(makeInitialReviewReport({ verdict: 'APPROVE' }));

      const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });
      await useCase.execute(makeJob({ mode: 'initial' }));

      const prompt = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      expect(prompt).toContain('Mode INITIAL');
      expect(prompt).toContain('review-notes.md');
      expect(prompt).toContain('Verdict: APPROVE | CHANGES REQUESTED | DEFER');
      expect(prompt).not.toContain('fix-review-log.md');
      expect(readFixReviewLogMock).not.toHaveBeenCalled();
    });

    it.each([
      ['APPROVE', 'APPROVE'],
      ['CHANGES_REQUESTED', 'REQUEST_CHANGES'],
      ['DEFER', 'COMMENT'],
    ] as const)('maps Verdict %s to GitHub event %s, identical to review-command.js', async (verdict, event) => {
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
      readInitialReviewReportMock.mockResolvedValue(makeInitialReviewReport({ verdict }));

      const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });
      await useCase.execute(makeJob({ mode: 'initial' }));

      expect(vcsClient.createPullRequestReview).toHaveBeenCalledTimes(1);
      expect(vcsClient.createPullRequestReview).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'ganjardbc', repo: 'umkm-pos', prNumber: 42, event }),
      );
      expect(vcsClient.postIssueComment).not.toHaveBeenCalled();
      expect(vcsClient.replyToReviewComment).not.toHaveBeenCalled();
    });

    it('throws when review-notes.md is not produced', async () => {
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
      readInitialReviewReportMock.mockResolvedValue(undefined);

      const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });

      await expect(useCase.execute(makeJob({ mode: 'initial' }))).rejects.toThrow(/No review-notes.md produced/);
      expect(vcsClient.createPullRequestReview).not.toHaveBeenCalled();
    });

    it('STOPs (throws, does not default to any event) when readInitialReviewReport rejects an unrecognized/missing Verdict', async () => {
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
      readInitialReviewReportMock.mockRejectedValue(new Error('review-notes.md has an unrecognized Verdict: "MAYBE"'));

      const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });

      await expect(useCase.execute(makeJob({ mode: 'initial' }))).rejects.toThrow(/unrecognized Verdict/);
      expect(vcsClient.createPullRequestReview).not.toHaveBeenCalled();
    });

    it('auto-falls back to event COMMENT with the real Verdict stated explicitly when GitHub rejects a self-review (422)', async () => {
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
      readInitialReviewReportMock.mockResolvedValue(
        makeInitialReviewReport({ verdict: 'CHANGES_REQUESTED', raw: 'Verdict: CHANGES REQUESTED\nsome findings' }),
      );
      (vcsClient.createPullRequestReview as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new SelfReviewRejectedError('GitHub rejected self-review for event "REQUEST_CHANGES" (422)'))
        .mockResolvedValueOnce({ url: 'https://github.com/ganjardbc/umkm-pos/pull/42#review-2', id: 2 });

      const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });
      await useCase.execute(makeJob({ mode: 'initial' }));

      expect(vcsClient.createPullRequestReview).toHaveBeenCalledTimes(2);
      expect(vcsClient.createPullRequestReview).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ event: 'REQUEST_CHANGES' }),
      );
      const fallbackCall = (vcsClient.createPullRequestReview as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(fallbackCall.event).toBe('COMMENT');
      expect(fallbackCall.body).toContain('Verdict: CHANGES REQUESTED');
      expect(fallbackCall.body).toContain('posted as COMMENT');
    });

    it('does not retry and rethrows a createPullRequestReview failure that is not a self-review rejection', async () => {
      (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgentResult({ exitCode: 0 }));
      readInitialReviewReportMock.mockResolvedValue(makeInitialReviewReport({ verdict: 'APPROVE' }));
      (vcsClient.createPullRequestReview as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('PR is closed'));

      const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });

      await expect(useCase.execute(makeJob({ mode: 'initial' }))).rejects.toThrow(/PR is closed/);
      expect(vcsClient.createPullRequestReview).toHaveBeenCalledTimes(1);
    });
  });
});
