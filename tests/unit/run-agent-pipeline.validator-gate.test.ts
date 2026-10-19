import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IGitService, IWorkspaceManager } from '../../src/domain/interfaces/git.interface.js';
import type { IAgentRunner, AgentRunResult } from '../../src/domain/interfaces/agent-runner.interface.js';
import type { IAgentCatalog } from '../../src/domain/interfaces/agent-catalog.interface.js';
import type { ILinearClient } from '../../src/domain/interfaces/linear-client.interface.js';
import type { INotifier } from '../../src/domain/interfaces/notifier.interface.js';
import type { IVcsClient } from '../../src/domain/interfaces/vcs-client.interface.js';
import type { ExistingJobPayload } from '../../src/domain/interfaces/queue.interface.js';

// CAF-SDD-04a: the gate agent (caf-validator vs caf-qa), its report file and
// the documentation step are picked from the agent definitions present in the
// workspace, through the IAgentCatalog port.

vi.mock('../../src/infrastructure/logging/logger.js', () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() },
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
const readValidateReportMock = vi.fn();
const readReviewerReportMock = vi.fn();
vi.mock('../../src/infrastructure/reports/report-reader.js', () => ({
  readTasks: readTasksMock,
  readVerifyReport: readVerifyReportMock,
  readQaReport: readQaReportMock,
  readValidateReport: readValidateReportMock,
  readReviewerReport: readReviewerReportMock,
  appendSkipNote: vi.fn().mockResolvedValue(undefined),
  taskDir: (workspacePath: string, ticketKey: string) => `${workspacePath}/.caf/tasks/${ticketKey}`,
}));

const readOrchestrationStateMock = vi.fn();
vi.mock('../../src/infrastructure/reports/orchestration-state.js', () => ({
  recordGateFailure: vi.fn().mockResolvedValue(undefined),
  resetOrchestrationState: vi.fn().mockResolvedValue(undefined),
  readOrchestrationState: readOrchestrationStateMock,
  incrementOrchestrationRetryCount: vi.fn().mockResolvedValue(1),
}));

const recordAgentEventMock = vi.fn();
const recordAgentEndMock = vi.fn();
vi.mock('../../src/infrastructure/db/pipeline-instrumentation.js', () => ({
  repoIdFromCloneUrl: () => 'ganjardbc/umkm-pos',
  recordPipelineStarted: vi.fn(),
  finalizePipelineRun: vi.fn(),
  recordAgentEvent: recordAgentEventMock,
  recordAgentEnd: recordAgentEndMock,
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
};
vi.mock('../../src/config/index.js', () => ({ config: configMock }));

const { RunAgentPipelineUseCase } = await import('../../src/application/use-cases/run-agent-pipeline.use-case.js');

const ok = (): AgentRunResult => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false });

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

function makeRetryJob(): ExistingJobPayload {
  return makeJob({
    isRetry: true,
    maxOrchestrationRetries: 2,
    retryContext: { owner: 'ganjardbc', repo: 'umkm-pos', prNumber: 7 },
  });
}

const QA_GATE_STATE = {
  orchestrationRetryCount: 0,
  lastFailedGate: 'qa',
  lastFailedAt: '2026-01-01T00:00:00.000Z',
  lastKnownCommitSha: 'deadbeef',
  ticketTitle: 'Stored title',
  ticketDescription: 'Stored description',
};

describe('RunAgentPipelineUseCase — CAF-SDD-04a validator gate', () => {
  let gitService: IGitService;
  let workspaceManager: IWorkspaceManager;
  let agentRunner: IAgentRunner;
  let linearClient: ILinearClient;
  let vcsClient: IVcsClient;
  let notifier: INotifier;
  let presentAgents: Set<string>;
  let agentCatalog: IAgentCatalog;

  const makeUseCase = () =>
    new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier, agentCatalog });
  const ranAgents = () => (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
  const comments = () => (linearClient.postComment as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as string);
  const prBodies = () => (vcsClient.createPullRequest as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].body as string);

  beforeEach(() => {
    vi.clearAllMocks();

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
      createWorkspace: vi.fn().mockResolvedValue('/tmp/workspace-sdd04a'),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
      validatePath: vi.fn().mockReturnValue(true),
    };
    agentRunner = { run: vi.fn().mockResolvedValue(ok()) };
    linearClient = { postComment: vi.fn().mockResolvedValue(undefined), updateStatus: vi.fn().mockResolvedValue(undefined) };
    vcsClient = {
      createPullRequest: vi.fn().mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/1', number: 1 }),
      replyToReviewComment: vi.fn().mockResolvedValue(undefined),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
      createPullRequestReview: vi.fn().mockResolvedValue({ url: 'x', id: 1 }),
      findOpenPullRequestByHead: vi.fn().mockResolvedValue(undefined),
      updatePullRequest: vi.fn().mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/1', number: 1 }),
      markPullRequestReadyForReview: vi.fn().mockResolvedValue(true),
    };
    notifier = {
      notifyPipelineStarted: vi.fn().mockResolvedValue(undefined),
      notifyPipelineComplete: vi.fn().mockResolvedValue(undefined),
      notifyPipelineFailed: vi.fn().mockResolvedValue(undefined),
      notifyPipelineNeedsHuman: vi.fn().mockResolvedValue(undefined),
      notifyAgentSkipped: vi.fn().mockResolvedValue(undefined),
      notifyAgentStarted: vi.fn().mockResolvedValue(undefined),
    };

    presentAgents = new Set(['caf-planner', 'caf-backend', 'caf-reviewer', 'caf-documentation']);
    agentCatalog = { hasAgent: vi.fn(async (_repoPath: string, name: string) => presentAgents.has(name)) };

    readTasksMock.mockResolvedValue('# Tasks\n## Backend Tasks\n- do the thing\n');
    routeTasksMock.mockReturnValue(['caf-backend']);
    hasDocsTasksMock.mockReturnValue(false);
    parseSkipDirectivesMock.mockReturnValue(new Map());
    readVerifyReportMock.mockResolvedValue({ status: 'SUCCESS', raw: 'Status: SUCCESS' });
    readQaReportMock.mockResolvedValue({ status: 'PASS', raw: '## QA Report\nStatus: PASS' });
    readValidateReportMock.mockResolvedValue({ status: 'PASS', raw: '## Validate Report\nAgent: caf-validator\nStatus: PASS' });
    readReviewerReportMock.mockResolvedValue({ verdict: 'APPROVE', raw: 'Verdict: APPROVE' });
    readOrchestrationStateMock.mockResolvedValue(undefined);
  });

  describe('AC-1: gate agent chosen from .claude/agents in the workspace', () => {
    it('runs caf-validator and reads validate-report.md when caf-validator.md exists', async () => {
      presentAgents.add('caf-validator');

      await makeUseCase().execute(makeJob());

      expect(agentCatalog.hasAgent).toHaveBeenCalledWith('/tmp/workspace-sdd04a/repo', 'caf-validator');
      expect(ranAgents()).toEqual(['caf-planner', 'caf-backend', 'caf-validator', 'caf-reviewer']);
      expect(agentRunner.run).toHaveBeenCalledWith(
        'caf-validator',
        expect.any(String),
        expect.stringContaining('.caf/tasks/CAF-123/validate-report.md'),
        undefined,
      );
      expect(readValidateReportMock).toHaveBeenCalledWith('/tmp/workspace-sdd04a/repo', 'CAF-123');
      expect(readQaReportMock).not.toHaveBeenCalled();
      expect(vcsClient.createPullRequest).toHaveBeenCalledTimes(1);
    });

    it('runs caf-qa and reads qa-report.md, as before, when caf-validator.md does not exist', async () => {
      await makeUseCase().execute(makeJob());

      expect(ranAgents()).toEqual(['caf-planner', 'caf-backend', 'caf-qa', 'caf-reviewer']);
      expect(readQaReportMock).toHaveBeenCalledWith('/tmp/workspace-sdd04a/repo', 'CAF-123');
      expect(readValidateReportMock).not.toHaveBeenCalled();
    });

    it('falls back to qa-report.md when caf-validator wrote no validate-report.md', async () => {
      presentAgents.add('caf-validator');
      readValidateReportMock.mockResolvedValue(undefined);

      await makeUseCase().execute(makeJob());

      expect(readQaReportMock).toHaveBeenCalled();
      expect(vcsClient.createPullRequest).toHaveBeenCalledTimes(1);
      expect(prBodies()[0]).toContain('.caf/tasks/CAF-123/qa-report.md');
    });

    it('uses a per-project model override for caf-validator', async () => {
      presentAgents.add('caf-validator');

      await makeUseCase().execute(
        makeJob({
          projectConfig: { ...makeJob().projectConfig, agents: { modelOverrides: { 'caf-validator': 'model-x' } } },
        }),
      );

      expect(agentRunner.run).toHaveBeenCalledWith('caf-validator', expect.any(String), expect.any(String), 'model-x');
    });
  });

  describe('AC-2 / Q-3: gate outcome follows the old retry/Draft PR rules for both report names', () => {
    it('retries implementation once on validate-report FAIL, then opens a Draft PR', async () => {
      presentAgents.add('caf-validator');
      readValidateReportMock.mockResolvedValue({ status: 'FAIL', raw: 'Status: FAIL' });

      await makeUseCase().execute(makeJob());

      expect(ranAgents()).toEqual(['caf-planner', 'caf-backend', 'caf-validator', 'caf-backend', 'caf-validator']);
      expect(vcsClient.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
    });

    it('treats a missing gate report (neither validate-report.md nor qa-report.md) as a gate failure, not a thrown error', async () => {
      presentAgents.add('caf-validator');
      readValidateReportMock.mockResolvedValue(undefined);
      readQaReportMock.mockResolvedValue(undefined);

      await expect(makeUseCase().execute(makeJob())).resolves.toBeUndefined();

      expect(ranAgents()).toEqual(['caf-planner', 'caf-backend', 'caf-validator', 'caf-backend', 'caf-validator']);
      expect(vcsClient.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
      expect(notifier.notifyPipelineFailed).not.toHaveBeenCalled();
    });

    it('treats a missing qa-report.md from caf-qa as a gate failure too', async () => {
      readQaReportMock.mockResolvedValue(undefined);

      await expect(makeUseCase().execute(makeJob())).resolves.toBeUndefined();

      expect(vcsClient.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
      expect(comments().at(-1)).toContain('qa-report.md');
    });
  });

  describe('AC-5: documentation step', () => {
    it('skips the docs step without error or failure comment when caf-documentation.md does not exist', async () => {
      presentAgents.delete('caf-documentation');
      hasDocsTasksMock.mockReturnValue(true);

      await makeUseCase().execute(makeJob());

      expect(ranAgents()).not.toContain('caf-documentation');
      expect(vcsClient.createPullRequest).toHaveBeenCalledTimes(1);
      const finalComment = comments().at(-1)!;
      expect(finalComment).toContain('Agent pipeline complete');
      expect(finalComment).not.toMatch(/failed|errored/i);
      expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
    });

    it('runs caf-documentation as before when caf-documentation.md exists', async () => {
      hasDocsTasksMock.mockReturnValue(true);

      await makeUseCase().execute(makeJob());

      expect(ranAgents()).toContain('caf-documentation');
      expect(comments().at(-1)).toContain('caf-Documentation agent updated docs');
    });
  });

  describe('AC-6: names in comments, PR bodies and dashboard events follow the agent that ran', () => {
    it('validator gate exhausted: Draft PR body, ticket comment and gate_exhausted event name caf-validator / validate-report.md', async () => {
      presentAgents.add('caf-validator');
      readValidateReportMock.mockResolvedValue({ status: 'FAIL', raw: 'Status: FAIL' });

      await makeUseCase().execute(makeJob());

      const draftBody = prBodies()[0];
      expect(draftBody).toContain('.caf/tasks/CAF-123/validate-report.md');
      expect(draftBody).not.toContain('qa-report.md');
      const gateComment = comments().at(-1)!;
      expect(gateComment).toContain('caf-validator');
      expect(gateComment).toContain('validate-report.md');
      expect(gateComment).not.toContain('qa-report.md');

      expect(recordAgentEventMock).toHaveBeenCalledWith('ganjardbc/umkm-pos', 'CAF-123', 'caf-validator', 'verify', 'start');
      expect(recordAgentEventMock).toHaveBeenCalledWith('ganjardbc/umkm-pos', 'CAF-123', 'caf-validator', 'verify', 'retry', {
        retryCount: 1,
      });
      expect(recordAgentEventMock).toHaveBeenCalledWith('ganjardbc/umkm-pos', 'CAF-123', 'caf-validator', 'verify', 'gate_exhausted', {
        artifactLink: '.caf/tasks/CAF-123/validate-report.md',
      });
      expect(recordAgentEndMock).toHaveBeenCalledWith('ganjardbc/umkm-pos', 'CAF-123', 'caf-validator', 'verify', expect.anything());
      const eventAgentNames = recordAgentEventMock.mock.calls.map((call) => call[2]);
      expect(eventAgentNames).not.toContain('caf-qa');
      expect(notifier.notifyAgentStarted).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'caf-validator' }));
    });

    it('validator success: PR body and final comment name validate-report.md, never qa-report.md', async () => {
      presentAgents.add('caf-validator');

      await makeUseCase().execute(makeJob());

      const body = prBodies()[0];
      expect(body).toContain('.caf/tasks/CAF-123/validate-report.md');
      expect(body).not.toContain('qa-report.md');
      const finalComment = comments().at(-1)!;
      expect(finalComment).toContain('caf-validator');
      expect(finalComment).toContain('validate-report.md');
    });

    it('caf-qa gate exhausted: names stay caf-qa / qa-report.md', async () => {
      readQaReportMock.mockResolvedValue({ status: 'FAIL', raw: 'Status: FAIL' });

      await makeUseCase().execute(makeJob());

      expect(prBodies()[0]).toContain('.caf/tasks/CAF-123/qa-report.md');
      expect(recordAgentEventMock).toHaveBeenCalledWith('ganjardbc/umkm-pos', 'CAF-123', 'caf-qa', 'verify', 'gate_exhausted', {
        artifactLink: '.caf/tasks/CAF-123/qa-report.md',
      });
      expect(comments().at(-1)).toMatch(/^Agent pipeline needs human review \(QA failed after retry\):/);
    });

    it('validator skipped by Planner directive: warning and skip notification name the validator', async () => {
      configMock.AGENT_SKIP_ENABLED = true;
      presentAgents.add('caf-validator');
      parseSkipDirectivesMock.mockReturnValue(new Map([['qa', 'config only']]));

      try {
        await makeUseCase().execute(makeJob());
      } finally {
        configMock.AGENT_SKIP_ENABLED = false;
      }

      expect(ranAgents()).not.toContain('caf-validator');
      expect(notifier.notifyAgentSkipped).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'caf-validator' }));
      expect(prBodies()[0]).toContain('caf-Validator Agent tidak dijalankan');
    });
  });

  describe('AC-7: resume with lastFailedGate = qa', () => {
    it('re-reads validate-report.md when the repo uses caf-validator', async () => {
      presentAgents.add('caf-validator');
      readOrchestrationStateMock.mockResolvedValue(QA_GATE_STATE);
      readValidateReportMock
        .mockResolvedValueOnce({ status: 'FAIL', raw: 'VALIDATOR SAID FAIL' })
        .mockResolvedValue({ status: 'PASS', raw: 'Status: PASS' });

      await makeUseCase().execute(makeRetryJob());

      const implementationPrompt = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === 'caf-backend')![2];
      expect(implementationPrompt).toContain('Previous validate-report.md');
      expect(implementationPrompt).toContain('VALIDATOR SAID FAIL');
      expect(readQaReportMock).not.toHaveBeenCalled();
    });

    it('re-reads qa-report.md when the repo has no caf-validator', async () => {
      readOrchestrationStateMock.mockResolvedValue(QA_GATE_STATE);
      readQaReportMock
        .mockResolvedValueOnce({ status: 'FAIL', raw: 'QA SAID FAIL' })
        .mockResolvedValue({ status: 'PASS', raw: 'Status: PASS' });

      await makeUseCase().execute(makeRetryJob());

      const implementationPrompt = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === 'caf-backend')![2];
      expect(implementationPrompt).toContain('Previous qa-report.md');
      expect(implementationPrompt).toContain('QA SAID FAIL');
      expect(readValidateReportMock).not.toHaveBeenCalled();
    });
  });
});
