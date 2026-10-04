import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IGitService, IWorkspaceManager } from '../../src/domain/interfaces/git.interface.js';
import type { IAgentRunner } from '../../src/domain/interfaces/agent-runner.interface.js';
import type { IVcsClient } from '../../src/domain/interfaces/vcs-client.interface.js';

// CAF-DASHBOARD-03 T2: same guarantee pipeline-instrumentation-db-unavailable
// .test.ts proves for the ticket pipeline — db.path can never be opened (a
// regular file used as a directory segment), so every history write fails,
// and the review job must still run to completion with warnings only.

const tmpDir = mkdtempSync(join(tmpdir(), 'caf-dashboard-03-dbfail-'));
const blockerFile = join(tmpDir, 'not-a-directory');
writeFileSync(blockerFile, 'x');
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const loggerWarnMock = vi.fn();
vi.mock('../../src/infrastructure/logging/logger.js', () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: loggerWarnMock, error: vi.fn(), fatal: vi.fn(), child: vi.fn() },
}));
vi.mock('../../src/infrastructure/reports/report-reader.js', () => ({
  readFixReviewLog: vi.fn().mockResolvedValue({ mode: undefined, raw: '', entries: [{ commentRef: '1', label: 'GENERAL', status: 'FIXED', note: '' }] }),
  readInitialReviewReport: vi.fn(),
}));
vi.mock('../../src/infrastructure/queue/dashboard-events.js', () => ({ publishDashboardEvent: vi.fn() }));
vi.mock('../../src/config/index.js', () => ({ config: { db: { path: join(blockerFile, 'sub', 'test.sqlite') } } }));

const { RunPrReviewUseCase } = await import('../../src/application/use-cases/run-pr-review.use-case.js');

describe('CAF-DASHBOARD-03: PR review job with the history DB unavailable', () => {
  it('completes normally and only logs warnings', async () => {
    const vcsClient = {
      replyToReviewComment: vi.fn().mockResolvedValue(undefined),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
      createPullRequestReview: vi.fn(),
    } as unknown as IVcsClient;
    const useCase = new RunPrReviewUseCase({
      gitService: { clone: vi.fn().mockResolvedValue(undefined) } as unknown as IGitService,
      workspaceManager: {
        createWorkspace: vi.fn().mockResolvedValue('/tmp/workspace-1'),
        cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
      } as unknown as IWorkspaceManager,
      agentRunner: {
        run: vi.fn().mockResolvedValue({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }),
      } as IAgentRunner,
      vcsClient,
    });

    await expect(
      useCase.execute({
        jobId: 'github-job-x',
        repoFullName: 'ganjardbc/umkm-pos',
        cloneUrl: 'https://github.com/ganjardbc/umkm-pos.git',
        prNumber: 7,
        prHeadBranch: 'ai-agent/CAF-9',
        mode: 'global',
        commentContext: [],
      }),
    ).resolves.toBeUndefined();

    expect(vcsClient.postIssueComment).toHaveBeenCalledTimes(1);
    // start, agent start, agent end, finalize — each one a swallowed failure.
    expect(loggerWarnMock).toHaveBeenCalledTimes(4);
    expect(loggerWarnMock.mock.calls.every(([message]) => /Pipeline-history DB write failed/.test(String(message)))).toBe(true);
  });
});
