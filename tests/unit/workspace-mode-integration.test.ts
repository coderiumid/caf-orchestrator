// CAF-WSMODE-01 Task 4d — cross-purpose integration test.
//
// Uses REAL WorkspaceManager + GitService (not mocked) against a local bare
// git fixture repo, so the actual filesystem/lock/preflight-cleanup
// mechanics are exercised end to end — only GitService.clone is spied (not
// stubbed away) to redirect the clone target from a fake github.com URL to
// the local bare fixture, since we can't hit real GitHub in a test. Verifies:
//   1. A persistent ticket-pipeline job reuses the same workspace dir across
//      runs (no re-clone on the second run).
//   2. A PR-review job for the same repo, under the same global
//      `workspace.mode: persistent` config, still gets a fresh ephemeral dir
//      and is cleaned up afterward — the persistent dir is untouched.
//   3. A "workspace busy" comment is actually posted to Linear (not just
//      the WorkspaceLock unit itself) when a second ticket-pipeline job hits
//      an already-held lock.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IAgentRunner, AgentRunResult } from '../../src/domain/interfaces/agent-runner.interface.js';
import type { ILinearClient } from '../../src/domain/interfaces/linear-client.interface.js';
import type { IVcsClient } from '../../src/domain/interfaces/vcs-client.interface.js';
import type { ExistingJobPayload, PrReviewJobPayload } from '../../src/domain/interfaces/queue.interface.js';

const workspaceRoot = mkdtempSync(join(tmpdir(), 'caf-orchestrator-wsmode-root-'));

const configMock = {
  AGENT_SKIP_ENABLED: false,
  agents: { qa: { maxRetries: 1 }, reviewer: { maxRetries: 1 } },
  workspace: { dir: workspaceRoot, mode: 'persistent' as 'ephemeral' | 'persistent' },
  GITHUB_TOKEN: undefined,
};
vi.mock('../../src/config/index.js', () => ({ config: configMock }));

vi.mock('../../src/infrastructure/logging/logger.js', () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() },
}));

const routeTasksMock = vi.fn().mockReturnValue(['caf-backend']);
const hasDocsTasksMock = vi.fn().mockReturnValue(false);
const parseSkipDirectivesMock = vi.fn().mockReturnValue(new Map());
vi.mock('../../src/infrastructure/agent/task-router.js', () => ({
  routeTasks: routeTasksMock,
  hasDocsTasks: hasDocsTasksMock,
  parseSkipDirectives: parseSkipDirectivesMock,
}));

const readTasksMock = vi.fn().mockResolvedValue('# Tasks\n## Backend Tasks\n- do the thing\n');
const readVerifyReportMock = vi.fn().mockResolvedValue({ status: 'SUCCESS', raw: 'SUCCESS: all good' });
const readQaReportMock = vi.fn().mockResolvedValue({ status: 'PASS', raw: 'PASS: all good' });
const readReviewerReportMock = vi.fn().mockResolvedValue({ verdict: 'APPROVE', raw: '## Verdict: APPROVE' });
const appendSkipNoteMock = vi.fn().mockResolvedValue(undefined);
const readFixReviewLogMock = vi.fn().mockResolvedValue({ mode: undefined, entries: [], raw: '' });
vi.mock('../../src/infrastructure/reports/report-reader.js', () => ({
  readTasks: readTasksMock,
  readVerifyReport: readVerifyReportMock,
  readQaReport: readQaReportMock,
  readReviewerReport: readReviewerReportMock,
  appendSkipNote: appendSkipNoteMock,
  readFixReviewLog: readFixReviewLogMock,
}));

const { GitService } = await import('../../src/infrastructure/git/git.service.js');
const { WorkspaceManager } = await import('../../src/infrastructure/git/workspace.manager.js');
const { workspaceLock } = await import('../../src/infrastructure/git/workspace-lock.js');
const { RunAgentPipelineUseCase } = await import('../../src/application/use-cases/run-agent-pipeline.use-case.js');
const { RunPrReviewUseCase } = await import('../../src/application/use-cases/run-pr-review.use-case.js');

const REPO_CLONE_URL = 'https://github.com/testorg/testrepo.git';
const PERSISTENT_DIR = join(workspaceRoot, 'persistent-testrepo');

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeAgentResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

function makeTicketJob(overrides: Partial<ExistingJobPayload> = {}): ExistingJobPayload {
  return {
    jobId: 'job-1',
    ticketId: 'ticket-uuid-1',
    ticketKey: 'CAF-A1',
    ticketTitle: 'Test ticket',
    ticketDescription: 'Test description',
    projectConfig: {
      repoCloneUrl: REPO_CLONE_URL,
      baseBranch: 'main',
      workspaceDir: workspaceRoot,
      agents: { modelOverrides: {} },
    },
    ...overrides,
  };
}

function makePrReviewJob(overrides: Partial<PrReviewJobPayload> = {}): PrReviewJobPayload {
  return {
    jobId: 'pr-job-1',
    repoFullName: 'testorg/testrepo',
    cloneUrl: REPO_CLONE_URL,
    prNumber: 7,
    prHeadBranch: 'ai-agent/CAF-PR',
    mode: 'initial',
    commentContext: [],
    ...overrides,
  };
}

describe('CAF-WSMODE-01 Task 4d — cross-purpose persistent/ephemeral integration', () => {
  let bareDir: string;
  let gitService: InstanceType<typeof GitService>;
  let workspaceManager: InstanceType<typeof WorkspaceManager>;
  let agentRunner: IAgentRunner;
  let linearClient: ILinearClient;
  let vcsClient: IVcsClient;

  beforeAll(() => {
    bareDir = mkdtempSync(join(tmpdir(), 'caf-orchestrator-wsmode-bare-'));
    sh('git init --bare', bareDir);

    const seedDir = mkdtempSync(join(tmpdir(), 'caf-orchestrator-wsmode-seed-'));
    sh(`git clone ${bareDir} ${seedDir}`, tmpdir());
    sh('git config user.email test@example.com', seedDir);
    sh('git config user.name test', seedDir);
    sh('git checkout -b main', seedDir);
    writeFileSync(join(seedDir, 'file.txt'), 'v1\n');
    sh('git add -A', seedDir);
    sh('git commit -m init', seedDir);
    sh('git push origin main', seedDir);
    // Fixture PR head branch for the PR-review job below — same commit as main.
    sh('git checkout -b ai-agent/CAF-PR', seedDir);
    sh('git push origin ai-agent/CAF-PR', seedDir);
    rmSync(seedDir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  });

  afterEach(() => {
    // Belt-and-suspenders: a failed assertion mid-test must not leak a held
    // lock into later tests.
    workspaceLock.release(PERSISTENT_DIR);
  });

  beforeAll(() => {
    configMock.workspace.mode = 'persistent';

    gitService = new GitService();
    // Only clone is redirected — real git.com URLs aren't reachable here.
    // preflightCleanup/createBranch/commitAll/push run for real against the
    // bare fixture repo (origin is set to bareDir by this clone).
    vi.spyOn(gitService, 'clone').mockImplementation(async (_repoUrl, branch, targetDir) => {
      sh(`git clone --branch ${branch} --single-branch -- ${bareDir} ${targetDir}`, workspaceRoot);
    });
    vi.spyOn(gitService, 'preflightCleanup');

    workspaceManager = new WorkspaceManager();

    agentRunner = { run: vi.fn().mockResolvedValue(makeAgentResult()) };
    linearClient = { postComment: vi.fn().mockResolvedValue(undefined), updateStatus: vi.fn().mockResolvedValue(undefined) };
    vcsClient = {
      createPullRequest: vi.fn().mockResolvedValue({ url: 'https://github.com/testorg/testrepo/pull/1', number: 1 }),
      replyToReviewComment: vi.fn().mockResolvedValue(undefined),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('first ticket-pipeline job clones fresh into persistent-<repo> and leaves it in place', async () => {
    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient });
    await useCase.execute(makeTicketJob({ jobId: 'job-a', ticketKey: 'CAF-A1' }));

    expect(gitService.clone).toHaveBeenCalledTimes(1);
    expect(gitService.preflightCleanup).not.toHaveBeenCalled();
    expect(existsSync(join(PERSISTENT_DIR, 'repo', '.git'))).toBe(true);
  });

  it('second ticket-pipeline job for the same repo reuses the dir via preflightCleanup instead of re-cloning', async () => {
    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient });
    await useCase.execute(makeTicketJob({ jobId: 'job-b', ticketKey: 'CAF-A2' }));

    expect(gitService.clone).toHaveBeenCalledTimes(1); // still just the first job's call
    expect(gitService.preflightCleanup).toHaveBeenCalledTimes(1);
    expect(gitService.preflightCleanup).toHaveBeenCalledWith(join(PERSISTENT_DIR, 'repo'), 'main', workspaceRoot);
    expect(existsSync(PERSISTENT_DIR)).toBe(true);
  });

  it('a PR-review job for the same repo (same global persistent config) still clones fresh into an ephemeral dir and cleans up', async () => {
    const useCase = new RunPrReviewUseCase({ gitService, workspaceManager, agentRunner, vcsClient });
    const cloneCallsBefore = (gitService.clone as ReturnType<typeof vi.fn>).mock.calls.length;

    await useCase.execute(makePrReviewJob());

    expect((gitService.clone as ReturnType<typeof vi.fn>).mock.calls.length).toBe(cloneCallsBefore + 1);
    const [, , ephemeralRepoPath] = (gitService.clone as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(ephemeralRepoPath).not.toContain('persistent-testrepo');
    expect(ephemeralRepoPath.startsWith(workspaceRoot)).toBe(true);

    // Ephemeral workspace removed after the job, persistent one untouched.
    expect(existsSync(ephemeralRepoPath.replace(/\/repo$/, ''))).toBe(false);
    expect(existsSync(join(PERSISTENT_DIR, 'repo', '.git'))).toBe(true);
  });

  it('rejects a ticket-pipeline job with a real "workspace busy" comment posted to Linear when the lock is already held', async () => {
    workspaceLock.acquire(PERSISTENT_DIR);
    const cloneCallsBefore = (gitService.clone as ReturnType<typeof vi.fn>).mock.calls.length;
    const postCommentCallsBefore = (linearClient.postComment as ReturnType<typeof vi.fn>).mock.calls.length;

    const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient });
    await expect(useCase.execute(makeTicketJob({ jobId: 'job-c', ticketId: 'ticket-uuid-c', ticketKey: 'CAF-A3' }))).resolves.toBeUndefined();

    const postCommentCalls = (linearClient.postComment as ReturnType<typeof vi.fn>).mock.calls;
    expect(postCommentCalls.length).toBe(postCommentCallsBefore + 1);
    const [ticketId, body] = postCommentCalls.at(-1)!;
    expect(ticketId).toBe('ticket-uuid-c');
    expect(body).toMatch(/busy/i);
    expect((gitService.clone as ReturnType<typeof vi.fn>).mock.calls.length).toBe(cloneCallsBefore); // no new clone attempted

    workspaceLock.release(PERSISTENT_DIR);
  });

  // CAF-WSMODE-01 Task 5 — regression: workspace.mode: ephemeral (the
  // pre-CAF-WSMODE-01 default) must behave identically to before this
  // ticket — fresh job-<uuid> clone every run, fully removed afterward, no
  // persistent-<repo> dir ever created, lock never touched.
  it('workspace.mode: ephemeral — every ticket-pipeline run clones fresh into a new dir and fully removes it after, real repo', async () => {
    configMock.workspace.mode = 'ephemeral';
    try {
      const useCase = new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient });
      const cloneCallsBefore = (gitService.clone as ReturnType<typeof vi.fn>).mock.calls.length;

      await useCase.execute(makeTicketJob({ jobId: 'job-eph-1', ticketId: 'ticket-uuid-eph-1', ticketKey: 'CAF-E1' }));
      await useCase.execute(makeTicketJob({ jobId: 'job-eph-2', ticketId: 'ticket-uuid-eph-2', ticketKey: 'CAF-E2' }));

      const cloneCalls = (gitService.clone as ReturnType<typeof vi.fn>).mock.calls;
      expect(cloneCalls.length).toBe(cloneCallsBefore + 2); // both runs cloned fresh, no reuse
      const [, , firstRepoPath] = cloneCalls[cloneCallsBefore];
      const [, , secondRepoPath] = cloneCalls[cloneCallsBefore + 1];
      expect(firstRepoPath).not.toBe(secondRepoPath); // different job-<uuid> dirs, not reused
      expect(firstRepoPath).toMatch(/job-/);
      expect(secondRepoPath).toMatch(/job-/);

      // Both ephemeral workspaces fully removed — nothing left on disk.
      expect(existsSync(firstRepoPath.replace(/\/repo$/, ''))).toBe(false);
      expect(existsSync(secondRepoPath.replace(/\/repo$/, ''))).toBe(false);
      // No persistent-<repo> dir created as a side effect.
      expect(existsSync(join(workspaceRoot, 'persistent-testrepo-ephemeral-check'))).toBe(false);
      // Lock never engaged in ephemeral mode.
      expect(workspaceLock.isLocked(PERSISTENT_DIR)).toBe(false);
    } finally {
      configMock.workspace.mode = 'persistent';
    }
  });
});
