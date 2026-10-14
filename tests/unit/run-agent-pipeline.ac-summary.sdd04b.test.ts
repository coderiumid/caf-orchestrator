import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IGitService, IWorkspaceManager } from '../../src/domain/interfaces/git.interface.js';
import type { IAgentRunner, AgentRunResult } from '../../src/domain/interfaces/agent-runner.interface.js';
import type { IAgentCatalog } from '../../src/domain/interfaces/agent-catalog.interface.js';
import type { ILinearClient } from '../../src/domain/interfaces/linear-client.interface.js';
import type { INotifier } from '../../src/domain/interfaces/notifier.interface.js';
import type { IVcsClient } from '../../src/domain/interfaces/vcs-client.interface.js';
import type { ExistingJobPayload } from '../../src/domain/interfaces/queue.interface.js';

// CAF-SDD-04b: AC summary in PR bodies, the UNVERIFIED policy (Q-1) and the
// `validate` gate name in orchestration state.

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
const recordGateFailureMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/infrastructure/reports/orchestration-state.js', () => ({
  recordGateFailure: recordGateFailureMock,
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
  pivPhaseForAgent: () => 'implement',
}));

vi.mock('../../src/infrastructure/reports/verify-report-details.js', () => ({
  readVerifyDetails: vi.fn().mockResolvedValue(undefined),
}));

const readRequirementsTextMock = vi.fn();
vi.mock('../../src/infrastructure/reports/ac-summary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/infrastructure/reports/ac-summary.js')>()),
  readRequirementsText: readRequirementsTextMock,
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

const REQUIREMENTS = ['# Ticket', '- AC-1: a', '- AC-2: b', '- AC-3: c'].join('\n');

const gateReport = (rows: string[], notes: string[] = []) =>
  [
    '## Validate Report',
    'Agent: caf-validator',
    'Status: PASS',
    '',
    '| AC | Status | Evidence kind | Evidence |',
    '|----|--------|---------------|----------|',
    ...rows,
    ...(notes.length ? ['', '### Notes', ...notes] : []),
  ].join('\n');

const MIXED = gateReport(['| AC-1 | PASS | t | a.test.ts |', '| AC-2 | UNVERIFIED | none | no evidence reported |']);
const ALL_UNVERIFIED = gateReport([
  '| AC-1 | UNVERIFIED | none | no evidence reported |',
  '| AC-2 | UNVERIFIED | none | no evidence reported |',
  '| AC-3 | UNVERIFIED | none | no evidence reported |',
]);
const FAILING = gateReport(['| AC-1 | PASS | t | a.test.ts |', '| AC-2 | FAIL | t | broke |']);


describe('RunAgentPipelineUseCase — CAF-SDD-04b AC summary and validate gate', () => {
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
    readRequirementsTextMock.mockResolvedValue(REQUIREMENTS);
  });

  const useValidator = (raw: string, status: 'PASS' | 'FAIL' = 'PASS') => {
    presentAgents.add('caf-validator');
    readValidateReportMock.mockResolvedValue({ status, raw });
  };

  describe('AC-5: no requirements.md / no AC lines', () => {
    it('adds no summary and keeps the gate behavior', async () => {
      readRequirementsTextMock.mockResolvedValue(undefined);
      useValidator(ALL_UNVERIFIED);

      await makeUseCase().execute(makeJob());

      expect(prBodies()).toHaveLength(1);
      expect(prBodies()[0]).not.toContain('AC Summary');
      expect(vcsClient.createPullRequest).not.toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
      expect(ranAgents()).toContain('caf-reviewer');
    });

    it('requirements.md without AC lines behaves the same', async () => {
      readRequirementsTextMock.mockResolvedValue('# Ticket\nno numbered criteria');
      useValidator(ALL_UNVERIFIED);

      await makeUseCase().execute(makeJob());

      expect(prBodies()[0]).not.toContain('AC Summary');
      expect(ranAgents()).toContain('caf-reviewer');
    });
  });

  describe('AC-6: Status PASS but every AC UNVERIFIED (Q-1)', () => {
    it('stops as NEEDS_HUMAN with a Draft PR and comment, without retry or reviewer', async () => {
      useValidator(ALL_UNVERIFIED);

      await expect(makeUseCase().execute(makeJob())).resolves.toBeUndefined();

      expect(ranAgents()).toEqual(['caf-planner', 'caf-backend', 'caf-validator']);
      expect(vcsClient.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
      expect(comments().at(-1)).toContain('needs human review');
      expect(comments().at(-1)).toContain('UNVERIFIED');
      expect(notifier.notifyPipelineNeedsHuman).toHaveBeenCalledTimes(1);
      expect(notifier.notifyPipelineComplete).not.toHaveBeenCalled();
      expect(recordGateFailureMock).toHaveBeenCalledWith(expect.any(String), 'CAF-123', 'validate', 'deadbeef', expect.anything());
    });

    it('also stops when a retry after FAIL comes back PASS with everything UNVERIFIED', async () => {
      presentAgents.add('caf-validator');
      readValidateReportMock
        .mockResolvedValueOnce({ status: 'FAIL', raw: FAILING })
        .mockResolvedValue({ status: 'PASS', raw: ALL_UNVERIFIED });

      await makeUseCase().execute(makeJob());

      expect(ranAgents()).toEqual(['caf-planner', 'caf-backend', 'caf-validator', 'caf-backend', 'caf-validator']);
      expect(vcsClient.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
      expect(notifier.notifyPipelineComplete).not.toHaveBeenCalled();
    });

    it('does not apply when the Planner skipped the gate', async () => {
      useValidator(ALL_UNVERIFIED);
      parseSkipDirectivesMock.mockReturnValue(new Map([['qa', 'config only']]));
      configMock.AGENT_SKIP_ENABLED = true;
      try {
        await makeUseCase().execute(makeJob());
      } finally {
        configMock.AGENT_SKIP_ENABLED = false;
      }

      expect(ranAgents()).not.toContain('caf-validator');
      expect(ranAgents()).toContain('caf-reviewer');
      expect(prBodies()[0]).not.toContain('AC Summary');
    });
  });

  describe('AC-7: some AC proven, none FAIL', () => {
    it('passes even though some ACs are UNVERIFIED', async () => {
      useValidator(MIXED);

      await makeUseCase().execute(makeJob());

      expect(ranAgents()).toEqual(['caf-planner', 'caf-backend', 'caf-validator', 'caf-reviewer']);
      expect(vcsClient.createPullRequest).not.toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
      expect(notifier.notifyPipelineComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-8 / AC-10: summary at the top of the normal PR body', () => {
    it('starts with counts and the UNVERIFIED list with reasons', async () => {
      useValidator(MIXED);

      await makeUseCase().execute(makeJob());

      const body = prBodies()[0];
      expect(body.startsWith('## AC Summary\nPASS: 1 · FAIL: 0 · UNVERIFIED: 2')).toBe(true);
      expect(body).toContain('- AC-2: no evidence reported');
      expect(body).toContain('- AC-3: tidak dilaporkan');
      expect(body.indexOf('AC Summary')).toBeLessThan(body.indexOf('Ticket: CAF-123'));
    });

    it('shows the Proposed Spec Changes line from ### Notes', async () => {
      useValidator(gateReport(['| AC-1 | PASS | t | e |'], ['Proposed Spec Changes: AC-2 wording']));

      await makeUseCase().execute(makeJob());

      expect(prBodies()[0]).toContain('Proposed Spec Changes: AC-2 wording');
    });

    it('keeps the artifact text below the summary unchanged', async () => {
      useValidator(MIXED);
      await makeUseCase().execute(makeJob());
      const withSummary = prBodies()[0];

      vi.clearAllMocks();
      readRequirementsTextMock.mockResolvedValue(undefined);
      await makeUseCase().execute(makeJob());
      const without = (vcsClient.createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0][0].body as string;

      expect(withSummary.endsWith(`\n\n${without}`)).toBe(true);
    });
  });

  describe('AC-9: Draft PR on gate exhaustion', () => {
    it('puts the same summary on top and leaves the artifact part identical', async () => {
      useValidator(FAILING, 'FAIL');
      await makeUseCase().execute(makeJob());
      const withSummary = prBodies()[0];

      vi.clearAllMocks();
      readRequirementsTextMock.mockResolvedValue(undefined);
      await makeUseCase().execute(makeJob());
      const without = prBodies()[0];

      expect(withSummary.startsWith('## AC Summary\nPASS: 1 · FAIL: 1 · UNVERIFIED: 1')).toBe(true);
      expect(withSummary.endsWith(`\n\n${without}`)).toBe(true);
    });

    it('also updates an existing Draft PR with the summary on top', async () => {
      useValidator(FAILING, 'FAIL');
      (vcsClient.findOpenPullRequestByHead as ReturnType<typeof vi.fn>).mockResolvedValue({ number: 5, url: 'u' });

      await makeUseCase().execute(makeJob());

      const body = (vcsClient.updatePullRequest as ReturnType<typeof vi.fn>).mock.calls[0][0].body as string;
      expect(body.startsWith('## AC Summary')).toBe(true);
    });
  });

  describe('AC-11: no extra agent or model calls', () => {
    it('runs exactly the same agents with and without an AC summary', async () => {
      useValidator(MIXED);
      await makeUseCase().execute(makeJob());
      const withSummary = ranAgents();

      vi.clearAllMocks();
      readRequirementsTextMock.mockResolvedValue(undefined);
      await makeUseCase().execute(makeJob());

      expect(ranAgents()).toEqual(withSummary);
    });
  });

  describe('AC-12 / AC-13: gate name validate', () => {
    it('stores `validate` when the validation gate is exhausted by FAIL', async () => {
      useValidator(FAILING, 'FAIL');

      await makeUseCase().execute(makeJob());

      expect(recordGateFailureMock).toHaveBeenCalledWith(expect.any(String), 'CAF-123', 'validate', 'deadbeef', expect.anything());
    });

    it('stores `validate` for caf-qa repos too', async () => {
      readQaReportMock.mockResolvedValue({ status: 'FAIL', raw: 'Status: FAIL' });

      await makeUseCase().execute(makeJob());

      expect(recordGateFailureMock).toHaveBeenCalledWith(expect.any(String), 'CAF-123', 'validate', 'deadbeef', expect.anything());
    });

    for (const stored of ['qa', 'validate']) {
      it(`resumes a stored "${stored}" gate from validate-report.md in a caf-validator repo`, async () => {
        presentAgents.add('caf-validator');
        readOrchestrationStateMock.mockResolvedValue({ ...QA_GATE_STATE, lastFailedGate: stored });
        readValidateReportMock
          .mockResolvedValueOnce({ status: 'FAIL', raw: 'VALIDATOR SAID FAIL' })
          .mockResolvedValue({ status: 'PASS', raw: MIXED });

        await makeUseCase().execute(makeRetryJob());

        const prompt = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === 'caf-backend')![2];
        expect(prompt).toContain('Previous validate-report.md');
        expect(prompt).toContain('VALIDATOR SAID FAIL');
      });

      it(`resumes a stored "${stored}" gate from qa-report.md in a caf-qa repo`, async () => {
        readOrchestrationStateMock.mockResolvedValue({ ...QA_GATE_STATE, lastFailedGate: stored });
        readQaReportMock
          .mockResolvedValueOnce({ status: 'FAIL', raw: 'QA SAID FAIL' })
          .mockResolvedValue({ status: 'PASS', raw: 'Status: PASS' });

        await makeUseCase().execute(makeRetryJob());

        const prompt = (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === 'caf-backend')![2];
        expect(prompt).toContain('Previous qa-report.md');
      });
    }
  });
});
