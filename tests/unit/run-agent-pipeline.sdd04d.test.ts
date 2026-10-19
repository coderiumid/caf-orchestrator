import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IGitService, IWorkspaceManager } from '../../src/domain/interfaces/git.interface.js';
import type { IAgentRunner, AgentRunResult } from '../../src/domain/interfaces/agent-runner.interface.js';
import type { ILinearClient } from '../../src/domain/interfaces/linear-client.interface.js';
import type { INotifier } from '../../src/domain/interfaces/notifier.interface.js';
import type { IVcsClient } from '../../src/domain/interfaces/vcs-client.interface.js';
import type { ExistingJobPayload } from '../../src/domain/interfaces/queue.interface.js';

// CAF-SDD-04d: Ready-for-review marking on resumed success, and a dashboard row
// left untouched by resumed jobs that run no agent. Fake ports; requirements.md
// and orchestration-state.json are real files in a temp workspace.

vi.mock('../../src/infrastructure/logging/logger.js', () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() },
}));

const routeTasksMock = vi.fn();
vi.mock('../../src/infrastructure/agent/task-router.js', () => ({
  routeTasks: routeTasksMock,
  hasDocsTasks: vi.fn().mockReturnValue(false),
  parseSkipDirectives: vi.fn().mockReturnValue(new Map()),
}));

const readTasksMock = vi.fn();
const readVerifyReportMock = vi.fn();
const readQaReportMock = vi.fn();
const readReviewerReportMock = vi.fn();
vi.mock('../../src/infrastructure/reports/report-reader.js', () => ({
  readTasks: readTasksMock,
  readVerifyReport: readVerifyReportMock,
  readQaReport: readQaReportMock,
  readValidateReport: vi.fn().mockResolvedValue(undefined),
  readReviewerReport: readReviewerReportMock,
  appendSkipNote: vi.fn().mockResolvedValue(undefined),
  taskDir: (workspacePath: string, ticketKey: string) => `${workspacePath}/.caf/tasks/${ticketKey}`,
}));

const finalizePipelineRunMock = vi.fn();
const recordPipelineStartedMock = vi.fn();
vi.mock('../../src/infrastructure/db/pipeline-instrumentation.js', () => ({
  repoIdFromCloneUrl: () => 'ganjardbc/umkm-pos',
  recordPipelineStarted: recordPipelineStartedMock,
  finalizePipelineRun: finalizePipelineRunMock,
  recordAgentEvent: vi.fn(),
  recordAgentEnd: vi.fn(),
  recordPullRequest: vi.fn(),
  recordWaitingFor: vi.fn(),
  recordAcSummary: vi.fn(),
  pivPhaseForAgent: () => 'implement',
}));

vi.mock('../../src/infrastructure/reports/verify-report-details.js', () => ({
  readVerifyDetails: vi.fn().mockResolvedValue(undefined),
}));

const configMock = {
  AGENT_SKIP_ENABLED: false,
  agents: { qa: { maxRetries: 1 }, reviewer: { maxRetries: 1 } },
  github: { readyLabel: 'ready-for-ai' },
};
vi.mock('../../src/config/index.js', () => ({ config: configMock }));

const { RunAgentPipelineUseCase } = await import('../../src/application/use-cases/run-agent-pipeline.use-case.js');
const { CLARIFY_COMMENT_MARKER } = await import('../../src/infrastructure/reports/spec-status.js');

const KEY = 'CAF-123';
const BRANCH = `ai-agent/${KEY}`;
const ok = (): AgentRunResult => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false });

const specText = (status: string, questions: string[] = []) =>
  ['# Spec', `Status: ${status}`, 'Source: chat', '', '## Open Questions', ...questions, '', '## Notes', 'plain notes'].join('\n');

const OPEN_Q = ['- Q-1 [BLOCKING] Which database? — Answer:', '- Q-2 [BLOCKING] Which auth flow? — Answer:'];
const MIXED_Q = ['- Q-1 [BLOCKING] Which database? — Answer:', '- Q-2 [BLOCKING] Already settled thing — Answer: yes'];

function makeJob(overrides: Partial<ExistingJobPayload> = {}): ExistingJobPayload {
  return {
    jobId: 'job-1',
    ticketId: 'ticket-uuid-1',
    ticketKey: KEY,
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

const gatedJob = (overrides: Partial<ExistingJobPayload> = {}) =>
  makeJob({ ticketLabels: ['spec-approval'], specGateLabel: 'spec-approval', ...overrides });

const clarifyResumeJob = (overrides: Partial<ExistingJobPayload> = {}) =>
  makeJob({ isRetry: true, maxOrchestrationRetries: 2, ...overrides });

const approveJob = (overrides: Partial<ExistingJobPayload> = {}) =>
  makeJob({
    ticketTitle: `Retry: ${KEY}`,
    ticketDescription: '',
    approveSpec: true,
    retryContext: { owner: 'ganjardbc', repo: 'umkm-pos', prNumber: 9 },
    ...overrides,
  });


const PR_URL = 'https://github.com/ganjardbc/umkm-pos/pull/9';

describe('RunAgentPipelineUseCase — CAF-SDD-04d', () => {
  let ws: string;
  let gitService: IGitService;
  let workspaceManager: IWorkspaceManager;
  let agentRunner: IAgentRunner;
  let linearClient: ILinearClient;
  let vcsClient: IVcsClient;
  let notifier: INotifier;
  let plannerSpec: string | undefined;

  const repo = () => join(ws, 'repo');
  const writeTaskFile = (file: string, content: string) => {
    mkdirSync(join(repo(), '.caf', 'tasks', KEY), { recursive: true });
    writeFileSync(join(repo(), '.caf', 'tasks', KEY, file), content, 'utf-8');
  };
  const seedState = (state: Record<string, unknown>) =>
    writeTaskFile(
      'orchestration-state.json',
      JSON.stringify({
        orchestrationRetryCount: 0,
        lastFailedGate: 'implementation',
        lastFailedAt: null,
        lastKnownCommitSha: null,
        ticketTitle: 'Stored title',
        ticketDescription: 'Stored description',
        ...state,
      }),
    );
  const makeUseCase = () => new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
  const ranAgents = () => (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
  const ticketComments = () => (linearClient.postComment as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as string);
  const prComments = () => (vcsClient.postIssueComment as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].body as string);
  // Comments of a retry/approve job go to the PR (retryContext), the rest to Linear.
  const allComments = () => [...ticketComments(), ...prComments()];
  const dashboardUntouched = () => {
    expect(recordPipelineStartedMock).not.toHaveBeenCalled();
    expect(finalizePipelineRunMock).not.toHaveBeenCalled();
  };

  const retryJob = (overrides: Partial<ExistingJobPayload> = {}) =>
    makeJob({
      isRetry: true,
      maxOrchestrationRetries: 2,
      retryContext: { owner: 'ganjardbc', repo: 'umkm-pos', prNumber: 9 },
      ...overrides,
    });
  const approveJob = () =>
    makeJob({ approveSpec: true, retryContext: { owner: 'ganjardbc', repo: 'umkm-pos', prNumber: 9 } });
  const withOpenPr = () =>
    (vcsClient.findOpenPullRequestByHead as ReturnType<typeof vi.fn>).mockResolvedValue({ url: PR_URL, number: 9 });

  beforeEach(() => {
    vi.clearAllMocks();
    ws = mkdtempSync(join(tmpdir(), 'caf-sdd04d-'));
    mkdirSync(repo(), { recursive: true });
    plannerSpec = undefined;

    gitService = {
      clone: vi.fn().mockResolvedValue(undefined),
      createBranch: vi.fn().mockResolvedValue(undefined),
      commitAll: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockResolvedValue(undefined),
      getHeadCommit: vi.fn().mockResolvedValue('deadbeef'),
      preflightCleanup: vi.fn(),
      getWorkspaceStatus: vi.fn().mockResolvedValue({ hasUncommittedChanges: false, statusOutput: '' }),
      diffStat: vi.fn().mockResolvedValue(''),
      remoteBranchExists: vi.fn().mockResolvedValue(true),
    };
    workspaceManager = {
      createWorkspace: vi.fn().mockResolvedValue(ws),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
      validatePath: vi.fn().mockReturnValue(true),
    };
    agentRunner = {
      run: vi.fn(async (name: string) => {
        if (name === 'caf-planner' && plannerSpec !== undefined) writeTaskFile('requirements.md', plannerSpec);
        return ok();
      }),
    };
    linearClient = {
      postComment: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      listComments: vi.fn().mockResolvedValue([]),
    };
    vcsClient = {
      createPullRequest: vi.fn().mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/5', number: 5 }),
      replyToReviewComment: vi.fn().mockResolvedValue(undefined),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
      createPullRequestReview: vi.fn().mockResolvedValue({ url: 'x', id: 1 }),
      findOpenPullRequestByHead: vi.fn().mockResolvedValue(undefined),
      updatePullRequest: vi.fn().mockResolvedValue({ url: PR_URL, number: 9 }),
      markPullRequestReadyForReview: vi.fn().mockResolvedValue(true),
      listTicketComments: vi.fn().mockResolvedValue([]),
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
    readVerifyReportMock.mockResolvedValue({ status: 'SUCCESS', raw: 'Status: SUCCESS' });
    readQaReportMock.mockResolvedValue({ status: 'PASS', raw: '## QA Report\nStatus: PASS' });
    readReviewerReportMock.mockResolvedValue({ verdict: 'APPROVE', raw: 'Verdict: APPROVE' });
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  describe('Ready for review on resumed success (AC-8 to AC-10)', () => {
    it('AC-8: a resumed run (retry) marks the updated PR Ready and the comment says so', async () => {
      seedState({});
      withOpenPr();

      await makeUseCase().execute(retryJob());

      expect(vcsClient.updatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 9 }));
      expect(vcsClient.markPullRequestReadyForReview).toHaveBeenCalledWith({ owner: 'ganjardbc', repo: 'umkm-pos', prNumber: 9 });
      expect((vcsClient.updatePullRequest as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
        (vcsClient.markPullRequestReadyForReview as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
      );
      expect(prComments().at(-1)).toContain('Agent pipeline complete');
      expect(prComments().at(-1)).toContain('now marked Ready for review');
    });

    it('AC-8: an approved spec (approveSpec) marks the spec Draft PR Ready too', async () => {
      seedState({ waitingFor: 'spec-approval' });
      writeTaskFile('requirements.md', specText('DRAFT'));
      withOpenPr();

      await makeUseCase().execute(approveJob());

      expect(vcsClient.markPullRequestReadyForReview).toHaveBeenCalledWith({ owner: 'ganjardbc', repo: 'umkm-pos', prNumber: 9 });
      expect(prComments().at(-1)).toContain('now marked Ready for review');
    });

    it('AC-9: a first run creates a non-draft PR and never calls ready-marking', async () => {
      plannerSpec = specText('APPROVED');

      await makeUseCase().execute(makeJob());

      expect(vcsClient.createPullRequest).toHaveBeenCalledTimes(1);
      expect(vcsClient.markPullRequestReadyForReview).not.toHaveBeenCalled();
      expect(ticketComments().at(-1)).not.toContain('Ready for review');
    });

    it('AC-10: ready-marking that throws leaves the job SUCCESS, throws nothing, and the comment says the PR stayed Draft and why', async () => {
      seedState({});
      withOpenPr();
      (vcsClient.markPullRequestReadyForReview as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Resource not accessible by personal access token'));

      await expect(makeUseCase().execute(retryJob())).resolves.toBeUndefined();

      expect(finalizePipelineRunMock).toHaveBeenCalledWith('ganjardbc/umkm-pos', KEY, 'SUCCESS');
      expect(finalizePipelineRunMock).not.toHaveBeenCalledWith('ganjardbc/umkm-pos', KEY, 'ERROR');
      expect(notifier.notifyPipelineFailed).not.toHaveBeenCalled();
      expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
      const comment = prComments().at(-1)!;
      expect(comment).toContain('Agent pipeline complete');
      expect(comment).toContain('stays a Draft');
      expect(comment).toContain('Resource not accessible by personal access token');
    });

    it('AC-8: an already-ready PR (method resolves false) adds no Ready sentence', async () => {
      seedState({});
      withOpenPr();
      (vcsClient.markPullRequestReadyForReview as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await makeUseCase().execute(retryJob());

      expect(prComments().at(-1)).not.toContain('Ready for review');
    });
  });

  describe('Rejected resume leaves the dashboard row alone (AC-13 to AC-16)', () => {
    const approveRejections: Array<[string, () => void, string]> = [
      ['not waiting for approval (no state)', () => undefined, 'is not waiting for spec approval'],
      [
        'waiting for clarify instead',
        () => {
          seedState({ waitingFor: 'clarify' });
          writeTaskFile('requirements.md', specText('NEEDS_CLARIFICATION', OPEN_Q));
        },
        'waiting for answers',
      ],
      [
        'no Status: line',
        () => {
          seedState({ waitingFor: 'spec-approval' });
          writeTaskFile('requirements.md', '# Spec\nno status here\n');
        },
        'no `Status:` line',
      ],
      [
        'Status NEEDS_CLARIFICATION',
        () => {
          seedState({ waitingFor: 'spec-approval' });
          writeTaskFile('requirements.md', specText('NEEDS_CLARIFICATION'));
        },
        'NEEDS_CLARIFICATION',
      ],
      [
        'unanswered BLOCKING',
        () => {
          seedState({ waitingFor: 'spec-approval' });
          writeTaskFile('requirements.md', specText('DRAFT', OPEN_Q));
        },
        'unanswered BLOCKING',
      ],
    ];

    it.each(approveRejections)('AC-13: /caf-approve-spec rejected (%s) — comment posted, no dashboard call', async (_name, arrange, text) => {
      arrange();

      await expect(makeUseCase().execute(approveJob())).resolves.toBeUndefined();

      dashboardUntouched();
      expect(ranAgents()).toEqual([]);
      expect(allComments().at(-1)).toContain('/caf-approve-spec');
      expect(allComments().at(-1)).toContain(text);
    });

    it('AC-14: branch gone on the remote', async () => {
      (gitService.remoteBranchExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await makeUseCase().execute(retryJob());

      dashboardUntouched();
      expect(ranAgents()).toEqual([]);
      expect(allComments().at(-1)).toContain('was not found on the remote');
      expect(notifier.notifyPipelineNeedsHuman).toHaveBeenCalledTimes(1);
    });

    it('AC-14: persistent workspace with uncommitted residue', async () => {
      mkdirSync(join(repo(), '.git'), { recursive: true });
      (gitService.getWorkspaceStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ hasUncommittedChanges: true, statusOutput: ' M a.ts' });

      await makeUseCase().execute(retryJob());

      dashboardUntouched();
      expect(gitService.preflightCleanup).not.toHaveBeenCalled();
      expect(ranAgents()).toEqual([]);
      expect(allComments().at(-1)).toContain('unexpected uncommitted changes');
    });

    it('AC-14: ticket waiting for spec approval is re-triggered', async () => {
      seedState({ waitingFor: 'spec-approval' });

      await makeUseCase().execute(retryJob());

      dashboardUntouched();
      expect(ranAgents()).toEqual([]);
      expect(allComments().at(-1)).toContain('waiting for approval of its spec');
    });

    it('AC-14: no orchestration state to resume', async () => {
      await makeUseCase().execute(retryJob());

      dashboardUntouched();
      expect(ranAgents()).toEqual([]);
      expect(allComments().at(-1)).toContain('nothing to resume');
    });

    it('AC-14: retry budget spent', async () => {
      seedState({ orchestrationRetryCount: 2 });

      await makeUseCase().execute(retryJob());

      dashboardUntouched();
      expect(ranAgents()).toEqual([]);
      expect(allComments().at(-1)).toContain('Retry limit reached');
    });

    it('AC-15: gate resume starts the row before the first agent and finalizes at the end', async () => {
      seedState({});

      await makeUseCase().execute(retryJob());

      expect(recordPipelineStartedMock).toHaveBeenCalledTimes(1);
      expect(recordPipelineStartedMock.mock.invocationCallOrder[0]).toBeLessThan(
        (agentRunner.run as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
      );
      expect(finalizePipelineRunMock).toHaveBeenLastCalledWith('ganjardbc/umkm-pos', KEY, 'SUCCESS');
    });

    it('AC-15: approved spec starts the row before the first agent', async () => {
      seedState({ waitingFor: 'spec-approval' });
      writeTaskFile('requirements.md', specText('DRAFT'));

      await makeUseCase().execute(approveJob());

      expect(recordPipelineStartedMock).toHaveBeenCalledTimes(1);
      expect(recordPipelineStartedMock.mock.invocationCallOrder[0]).toBeLessThan(
        (agentRunner.run as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
      );
      expect(finalizePipelineRunMock).toHaveBeenLastCalledWith('ganjardbc/umkm-pos', KEY, 'SUCCESS');
    });

    it('AC-15: Clarify resume starts the row before the planner and finalizes (here: stops again, NEEDS_HUMAN)', async () => {
      seedState({ waitingFor: 'clarify' });
      writeTaskFile('requirements.md', specText('NEEDS_CLARIFICATION', OPEN_Q));
      plannerSpec = specText('NEEDS_CLARIFICATION', OPEN_Q);

      await makeUseCase().execute(retryJob());

      expect(ranAgents()).toEqual(['caf-planner']);
      expect(recordPipelineStartedMock).toHaveBeenCalledTimes(1);
      expect(recordPipelineStartedMock.mock.invocationCallOrder[0]).toBeLessThan(
        (agentRunner.run as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
      );
      expect(finalizePipelineRunMock).toHaveBeenLastCalledWith('ganjardbc/umkm-pos', KEY, 'NEEDS_HUMAN');
    });

    it('AC-16: a first job calls recordPipelineStarted once, before the first agent', async () => {
      plannerSpec = specText('APPROVED');

      await makeUseCase().execute(makeJob());

      expect(recordPipelineStartedMock).toHaveBeenCalledTimes(1);
      expect(recordPipelineStartedMock).toHaveBeenCalledWith('ganjardbc/umkm-pos', KEY, 'Test ticket');
      expect(recordPipelineStartedMock.mock.invocationCallOrder[0]).toBeLessThan(
        (agentRunner.run as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
      );
    });
  });
});
