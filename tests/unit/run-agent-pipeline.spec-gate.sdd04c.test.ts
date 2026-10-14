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

// CAF-SDD-04c: Clarify via ticket, the labelled spec gate and /caf-approve-spec
// resume. Fake ports throughout; requirements.md and orchestration-state.json
// are real files in a temp workspace.

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
vi.mock('../../src/infrastructure/db/pipeline-instrumentation.js', () => ({
  repoIdFromCloneUrl: () => 'ganjardbc/umkm-pos',
  recordPipelineStarted: vi.fn(),
  finalizePipelineRun: finalizePipelineRunMock,
  recordAgentEvent: vi.fn(),
  recordAgentEnd: vi.fn(),
  recordPullRequest: vi.fn(),
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

describe('RunAgentPipelineUseCase — CAF-SDD-04c', () => {
  let ws: string;
  let gitService: IGitService;
  let workspaceManager: IWorkspaceManager;
  let agentRunner: IAgentRunner;
  let linearClient: ILinearClient;
  let vcsClient: IVcsClient;
  let notifier: INotifier;
  // What the fake planner leaves in requirements.md; undefined = writes none.
  let plannerSpec: string | undefined;

  const repo = () => join(ws, 'repo');
  const taskPath = (file: string) => join(repo(), '.caf', 'tasks', KEY, file);
  const writeTaskFile = (file: string, content: string) => {
    mkdirSync(join(repo(), '.caf', 'tasks', KEY), { recursive: true });
    writeFileSync(taskPath(file), content, 'utf-8');
  };
  const seedState = (state: Record<string, unknown>) =>
    writeTaskFile(
      'orchestration-state.json',
      JSON.stringify({
        orchestrationRetryCount: 0,
        lastFailedGate: null,
        lastFailedAt: null,
        lastKnownCommitSha: null,
        ticketTitle: 'Stored title',
        ticketDescription: 'Stored description',
        ...state,
      }),
    );
  const stateOnDisk = () => JSON.parse(readFileSync(taskPath('orchestration-state.json'), 'utf-8')) as Record<string, unknown>;

  const makeUseCase = () => new RunAgentPipelineUseCase({ gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier });
  const ranAgents = () => (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
  const plannerPrompt = () => (agentRunner.run as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === 'caf-planner')?.[2] as string;
  const ticketComments = () => (linearClient.postComment as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as string);
  const prComments = () => (vcsClient.postIssueComment as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as { issueNumber: number; body: string });
  const calledOrder = (fn: unknown, index = 0) => (fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[index];

  beforeEach(() => {
    vi.clearAllMocks();
    ws = mkdtempSync(join(tmpdir(), 'caf-sdd04c-'));
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
      updatePullRequest: vi.fn().mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/9', number: 9 }),
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

  describe('Clarify (AC-2 to AC-5)', () => {
    it('AC-2: NEEDS_CLARIFICATION stops after the planner — no implementation, no PR, run NEEDS_HUMAN', async () => {
      plannerSpec = specText('NEEDS_CLARIFICATION', OPEN_Q);

      await expect(makeUseCase().execute(makeJob())).resolves.toBeUndefined();

      expect(ranAgents()).toEqual(['caf-planner']);
      expect(vcsClient.createPullRequest).not.toHaveBeenCalled();
      expect(vcsClient.updatePullRequest).not.toHaveBeenCalled();
      expect(finalizePipelineRunMock).toHaveBeenCalledWith('ganjardbc/umkm-pos', KEY, 'NEEDS_HUMAN');
      expect(notifier.notifyPipelineNeedsHuman).toHaveBeenCalledTimes(1);
      expect(notifier.notifyPipelineComplete).not.toHaveBeenCalled();
    });

    it('AC-2: the label does not matter — a gated ticket also asks instead of opening a spec PR', async () => {
      plannerSpec = specText('NEEDS_CLARIFICATION', OPEN_Q);

      await makeUseCase().execute(gatedJob());

      expect(ranAgents()).toEqual(['caf-planner']);
      expect(vcsClient.createPullRequest).not.toHaveBeenCalled();
      expect(ticketComments().at(-1)).toContain('Which database?');
    });

    it('AC-3: commits and pushes the draft spec to the ticket branch without opening a PR', async () => {
      plannerSpec = specText('NEEDS_CLARIFICATION', OPEN_Q);

      await makeUseCase().execute(makeJob());

      expect(gitService.commitAll).toHaveBeenCalledTimes(1);
      expect(gitService.push).toHaveBeenCalledWith(repo(), BRANCH, expect.any(String));
      expect(calledOrder(gitService.commitAll)).toBeLessThan(calledOrder(gitService.push));
      expect(vcsClient.createPullRequest).not.toHaveBeenCalled();
      expect(stateOnDisk()).toMatchObject({ waitingFor: 'clarify' });
    });

    it('AC-4: the ticket comment lists each unanswered BLOCKING question, omits answered ones, and says how to re-trigger', async () => {
      plannerSpec = specText('NEEDS_CLARIFICATION', MIXED_Q);

      await makeUseCase().execute(makeJob());

      const comment = ticketComments().at(-1)!;
      expect(comment).toContain(CLARIFY_COMMENT_MARKER);
      expect(comment).toContain('Q-1');
      expect(comment).toContain('Which database?');
      expect(comment).not.toContain('Already settled thing');
      expect(comment).toContain('Ready for AI');
    });

    it('AC-4: on a GitHub Issue the comment goes to the issue and names the ready label', async () => {
      plannerSpec = specText('NEEDS_CLARIFICATION', OPEN_Q);

      await makeUseCase().execute(makeJob({ ticketSource: 'github', ticketId: '25' }));

      expect(linearClient.postComment).not.toHaveBeenCalled();
      const [comment] = prComments();
      expect(comment.issueNumber).toBe(25);
      expect(comment.body).toContain('ready-for-ai');
      expect(comment.body).toContain('Which auth flow?');
    });

    it('AC-5: stopping for Clarify does not touch the orchestration retry budget', async () => {
      plannerSpec = specText('NEEDS_CLARIFICATION', OPEN_Q);
      seedState({ orchestrationRetryCount: 1, waitingFor: 'clarify' });

      await makeUseCase().execute(clarifyResumeJob());

      expect(ranAgents()).toEqual(['caf-planner']);
      expect(stateOnDisk()).toMatchObject({ orchestrationRetryCount: 1, waitingFor: 'clarify' });
    });

    it('AC-5: a first-time Clarify stop records a count of 0', async () => {
      plannerSpec = specText('NEEDS_CLARIFICATION', OPEN_Q);

      await makeUseCase().execute(makeJob());

      expect(stateOnDisk()).toMatchObject({ orchestrationRetryCount: 0 });
    });

    it('a push failure is reported in the comment but does not throw', async () => {
      plannerSpec = specText('NEEDS_CLARIFICATION', OPEN_Q);
      (gitService.push as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('remote rejected'));

      await expect(makeUseCase().execute(makeJob())).resolves.toBeUndefined();

      expect(ticketComments().at(-1)).toContain('remote rejected');
    });
  });

  describe('Clarify resume (AC-6, AC-7)', () => {
    const human = (id: string, body: string) => ({ id, body, authorIsBot: false });

    beforeEach(() => {
      writeTaskFile('requirements.md', specText('NEEDS_CLARIFICATION', OPEN_Q));
      seedState({ waitingFor: 'clarify' });
    });

    it('AC-6: continues on the existing branch, not a fresh one, and runs the planner with the ticket answers', async () => {
      (linearClient.listComments as ReturnType<typeof vi.fn>).mockResolvedValue([
        human('1', 'a comment from before the questions'),
        human('2', `${CLARIFY_COMMENT_MARKER}\nquestions here`),
        human('3', 'Use Postgres please'),
      ]);
      plannerSpec = specText('DRAFT');

      await makeUseCase().execute(clarifyResumeJob());

      expect(gitService.remoteBranchExists).toHaveBeenCalledWith(expect.any(String), BRANCH, expect.any(String));
      expect(gitService.clone).toHaveBeenCalledWith(expect.any(String), BRANCH, repo(), expect.any(String));
      expect(gitService.createBranch).not.toHaveBeenCalled();
      expect(ranAgents()[0]).toBe('caf-planner');
      expect(plannerPrompt()).toContain('Use Postgres please');
      expect(plannerPrompt()).not.toContain('a comment from before the questions');
      expect(ranAgents()).toContain('caf-backend');
    });

    it('AC-7: bot comments and anything at or before the last Clarify comment stay out of the context', async () => {
      (linearClient.listComments as ReturnType<typeof vi.fn>).mockResolvedValue([
        human('1', 'ancient answer'),
        human('2', `${CLARIFY_COMMENT_MARKER}\nfirst round`),
        human('3', 'answer to first round'),
        human('4', `${CLARIFY_COMMENT_MARKER}\nsecond round`),
        { id: '5', body: 'bot status noise', authorIsBot: true },
        human('6', 'the real answer'),
      ]);
      plannerSpec = specText('DRAFT');

      await makeUseCase().execute(clarifyResumeJob());

      const prompt = plannerPrompt();
      expect(prompt).toContain('the real answer');
      expect(prompt).not.toContain('bot status noise');
      expect(prompt).not.toContain('answer to first round');
      expect(prompt).not.toContain('ancient answer');
    });

    it('AC-6: a GitHub Issue ticket reads its answers from the issue comments', async () => {
      (vcsClient.listTicketComments as ReturnType<typeof vi.fn>).mockResolvedValue([
        human('10', `${CLARIFY_COMMENT_MARKER}\nquestions`),
        human('11', 'Answer from the issue thread'),
      ]);
      plannerSpec = specText('DRAFT');

      await makeUseCase().execute(clarifyResumeJob({ ticketSource: 'github', ticketId: '25' }));

      expect(vcsClient.listTicketComments).toHaveBeenCalledWith({ owner: 'ganjardbc', repo: 'umkm-pos', issueNumber: 25 });
      expect(linearClient.listComments).not.toHaveBeenCalled();
      expect(plannerPrompt()).toContain('Answer from the issue thread');
    });

    it('is not a retry: no budget is consumed even at the limit, and a second NEEDS_CLARIFICATION asks again', async () => {
      seedState({ orchestrationRetryCount: 2, waitingFor: 'clarify' });
      plannerSpec = specText('NEEDS_CLARIFICATION', ['- Q-3 [BLOCKING] Still unclear? — Answer:']);

      await makeUseCase().execute(clarifyResumeJob());

      expect(ranAgents()).toEqual(['caf-planner']);
      expect(ticketComments().at(-1)).toContain('Still unclear?');
      expect(ticketComments().join('\n')).not.toContain('Retry limit reached');
      expect(stateOnDisk()).toMatchObject({ orchestrationRetryCount: 2, waitingFor: 'clarify' });
    });
  });

  describe('spec gate (AC-8 to AC-10)', () => {
    it('AC-8: DRAFT on an unlabelled ticket goes straight to implementation', async () => {
      plannerSpec = specText('DRAFT');

      await makeUseCase().execute(makeJob({ ticketLabels: ['bug'], specGateLabel: 'spec-approval' }));

      expect(ranAgents().slice(0, 2)).toEqual(['caf-planner', 'caf-backend']);
      expect(vcsClient.createPullRequest).not.toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
    });

    it('AC-8: a job with no label information behaves as before', async () => {
      plannerSpec = specText('DRAFT');

      await makeUseCase().execute(makeJob());

      expect(ranAgents().slice(0, 2)).toEqual(['caf-planner', 'caf-backend']);
    });

    it('AC-9: DRAFT on a labelled ticket pushes the spec, opens a spec-only Draft PR, comments the link, and stops', async () => {
      plannerSpec = specText('DRAFT');

      await expect(makeUseCase().execute(gatedJob())).resolves.toBeUndefined();

      expect(ranAgents()).toEqual(['caf-planner']);
      expect(gitService.commitAll).toHaveBeenCalledTimes(1);
      expect(gitService.push).toHaveBeenCalledWith(repo(), BRANCH, expect.any(String));
      expect(vcsClient.createPullRequest).toHaveBeenCalledTimes(1);
      const input = (vcsClient.createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(input).toMatchObject({ owner: 'ganjardbc', repo: 'umkm-pos', head: BRANCH, base: 'main', draft: true });
      expect(input.body).toContain('requirements.md');
      expect(input.body).toContain('/caf-approve-spec');
      expect(input.body).not.toContain('verify-report');
      expect(ticketComments().at(-1)).toContain('https://github.com/ganjardbc/umkm-pos/pull/5');
      expect(finalizePipelineRunMock).toHaveBeenCalledWith('ganjardbc/umkm-pos', KEY, 'NEEDS_HUMAN');
      expect(notifier.notifyPipelineNeedsHuman).toHaveBeenCalledTimes(1);
      expect(stateOnDisk()).toMatchObject({ waitingFor: 'spec-approval' });
    });

    it('AC-9: an already-open PR on the branch is updated, not duplicated', async () => {
      plannerSpec = specText('DRAFT');
      (vcsClient.findOpenPullRequestByHead as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://github.com/ganjardbc/umkm-pos/pull/9',
        number: 9,
      });

      await makeUseCase().execute(gatedJob());

      expect(vcsClient.createPullRequest).not.toHaveBeenCalled();
      expect(vcsClient.updatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 9 }));
    });

    it('AC-9: an already APPROVED spec on a labelled ticket does not stop', async () => {
      plannerSpec = specText('APPROVED');

      await makeUseCase().execute(gatedJob());

      expect(ranAgents().slice(0, 2)).toEqual(['caf-planner', 'caf-backend']);
      expect(vcsClient.createPullRequest).not.toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
    });

    it('AC-10: stopping at the spec gate leaves the retry budget as it was', async () => {
      plannerSpec = specText('DRAFT');
      writeTaskFile('requirements.md', specText('NEEDS_CLARIFICATION', OPEN_Q));
      seedState({ orchestrationRetryCount: 1, waitingFor: 'clarify' });

      await makeUseCase().execute(gatedJob({ isRetry: true, maxOrchestrationRetries: 2 }));

      expect(ranAgents()).toEqual(['caf-planner']);
      expect(stateOnDisk()).toMatchObject({ orchestrationRetryCount: 1, waitingFor: 'spec-approval' });
    });

    it('a retry trigger while the spec awaits approval points at the PR and runs nothing', async () => {
      writeTaskFile('requirements.md', specText('DRAFT'));
      seedState({ orchestrationRetryCount: 0, waitingFor: 'spec-approval' });

      await makeUseCase().execute(clarifyResumeJob());

      expect(ranAgents()).toEqual([]);
      expect(ticketComments().at(-1)).toContain('/caf-approve-spec');
      expect(gitService.commitAll).not.toHaveBeenCalled();
    });
  });

  describe('no spec (AC-18)', () => {
    it('AC-18: a repo whose planner writes no requirements.md never clarifies or gates', async () => {
      plannerSpec = undefined;

      await makeUseCase().execute(gatedJob());

      expect(ranAgents().slice(0, 2)).toEqual(['caf-planner', 'caf-backend']);
      expect(vcsClient.createPullRequest).not.toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
      expect(ticketComments().join('\n')).not.toContain(CLARIFY_COMMENT_MARKER);
    });

    it('AC-18: requirements.md without an anchored Status: line is ignored too', async () => {
      plannerSpec = '# Spec\nthe Status: NEEDS_CLARIFICATION text is only mentioned here\n- Q-1 [BLOCKING] x — Answer:\n';

      await makeUseCase().execute(gatedJob());

      expect(ranAgents().slice(0, 2)).toEqual(['caf-planner', 'caf-backend']);
      expect(vcsClient.createPullRequest).not.toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
    });
  });

  describe('/caf-approve-spec (AC-11 to AC-16)', () => {
    const waitingState = { orchestrationRetryCount: 1, waitingFor: 'spec-approval' };

    it('AC-11: sets only the Status line to APPROVED, commits and pushes it, then resumes at implementation without the planner', async () => {
      const before = specText('DRAFT', ['- Q-1 [BLOCKING] settled — Answer: yes']);
      writeTaskFile('requirements.md', before);
      seedState(waitingState);

      await expect(makeUseCase().execute(approveJob())).resolves.toBeUndefined();

      const after = readFileSync(taskPath('requirements.md'), 'utf-8');
      expect(after).toBe(before.replace('Status: DRAFT', 'Status: APPROVED'));
      expect(gitService.commitAll).toHaveBeenCalled();
      expect((gitService.commitAll as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain(KEY);
      expect(gitService.push).toHaveBeenCalledWith(repo(), BRANCH, expect.any(String));
      expect(gitService.preflightCleanup).not.toHaveBeenCalled();
      expect(gitService.clone).toHaveBeenCalledWith(expect.any(String), BRANCH, repo(), expect.any(String));
      expect(ranAgents()).not.toContain('caf-planner');
      expect(ranAgents()[0]).toBe('caf-backend');
      expect(readTasksMock).toHaveBeenCalledWith(repo(), KEY);
      expect(calledOrder(gitService.push)).toBeLessThan(calledOrder(agentRunner.run));
    });

    it('AC-11: the approval does not consume the retry budget (state count is unchanged when a later gate stops)', async () => {
      writeTaskFile('requirements.md', specText('DRAFT'));
      seedState(waitingState);
      readVerifyReportMock.mockResolvedValue({ status: 'NEEDS_HUMAN', raw: 'Status: NEEDS_HUMAN' });

      await makeUseCase().execute(approveJob());

      expect(stateOnDisk()).toMatchObject({ orchestrationRetryCount: 1, lastFailedGate: 'implementation' });
      expect(stateOnDisk().waitingFor).toBeUndefined();
    });

    it('AC-11: status comments go to the spec PR', async () => {
      writeTaskFile('requirements.md', specText('DRAFT'));
      seedState(waitingState);
      (vcsClient.findOpenPullRequestByHead as ReturnType<typeof vi.fn>).mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/9', number: 9 });

      await makeUseCase().execute(approveJob());

      expect(prComments().every((c) => c.issueNumber === 9)).toBe(true);
      expect(prComments().length).toBeGreaterThan(0);
      expect(linearClient.postComment).not.toHaveBeenCalled();
    });

    it('AC-13: a PR that is not waiting for spec approval gets an explanation and nothing runs', async () => {
      writeTaskFile('requirements.md', specText('DRAFT'));
      seedState({ orchestrationRetryCount: 0, lastFailedGate: 'reviewer' });

      await makeUseCase().execute(approveJob());

      expect(ranAgents()).toEqual([]);
      expect(gitService.commitAll).not.toHaveBeenCalled();
      expect(gitService.push).not.toHaveBeenCalled();
      expect(prComments()).toHaveLength(1);
      expect(prComments()[0].issueNumber).toBe(9);
      expect(prComments()[0].body).toContain('not waiting');
      expect(readFileSync(taskPath('requirements.md'), 'utf-8')).toContain('Status: DRAFT');
    });

    it('AC-13: no orchestration state at all is also "not waiting"', async () => {
      writeTaskFile('requirements.md', specText('DRAFT'));

      await makeUseCase().execute(approveJob());

      expect(ranAgents()).toEqual([]);
      expect(gitService.commitAll).not.toHaveBeenCalled();
      expect(prComments()[0].body).toContain('not waiting');
    });

    it('AC-13: a branch that is gone on the remote stops with a comment and no checkout', async () => {
      (gitService.remoteBranchExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await makeUseCase().execute(approveJob());

      expect(gitService.clone).not.toHaveBeenCalled();
      expect(ranAgents()).toEqual([]);
      expect(prComments()[0].body).toContain(BRANCH);
    });

    it('AC-13: a PR waiting for Clarify answers is told to answer on the ticket instead', async () => {
      writeTaskFile('requirements.md', specText('NEEDS_CLARIFICATION', OPEN_Q));
      seedState({ waitingFor: 'clarify' });

      await makeUseCase().execute(approveJob());

      expect(ranAgents()).toEqual([]);
      expect(gitService.commitAll).not.toHaveBeenCalled();
      expect(prComments()[0].body).toContain('not waiting');
    });

    it('AC-14: NEEDS_CLARIFICATION in the spec rejects the approval with a comment and no commit', async () => {
      writeTaskFile('requirements.md', specText('NEEDS_CLARIFICATION'));
      seedState(waitingState);

      await makeUseCase().execute(approveJob());

      expect(gitService.commitAll).not.toHaveBeenCalled();
      expect(gitService.push).not.toHaveBeenCalled();
      expect(ranAgents()).toEqual([]);
      expect(prComments()[0].body).toContain('NEEDS_CLARIFICATION');
      expect(readFileSync(taskPath('requirements.md'), 'utf-8')).toContain('Status: NEEDS_CLARIFICATION');
    });

    it('AC-14: an unanswered BLOCKING question rejects the approval and names the question', async () => {
      writeTaskFile('requirements.md', specText('DRAFT', OPEN_Q));
      seedState(waitingState);

      await makeUseCase().execute(approveJob());

      expect(gitService.commitAll).not.toHaveBeenCalled();
      expect(ranAgents()).toEqual([]);
      expect(prComments()[0].body).toContain('Which database?');
      expect(readFileSync(taskPath('requirements.md'), 'utf-8')).toContain('Status: DRAFT');
    });

    it('AC-15: a Status the human already set to APPROVED adds no commit but still resumes', async () => {
      writeTaskFile('requirements.md', specText('APPROVED'));
      seedState(waitingState);

      await makeUseCase().execute(approveJob());

      const approvalCommits = (gitService.commitAll as ReturnType<typeof vi.fn>).mock.calls.filter((call) => /approv/i.test(call[1] as string));
      expect(approvalCommits).toHaveLength(0);
      expect(ranAgents()[0]).toBe('caf-backend');
    });

    it('AC-16: success reuses the open spec PR instead of creating a second one', async () => {
      writeTaskFile('requirements.md', specText('DRAFT'));
      seedState(waitingState);
      (vcsClient.findOpenPullRequestByHead as ReturnType<typeof vi.fn>).mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/9', number: 9 });

      await makeUseCase().execute(approveJob());

      expect(vcsClient.createPullRequest).not.toHaveBeenCalled();
      expect(vcsClient.updatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 9 }));
      expect(prComments().at(-1)!.body).toContain('Agent pipeline complete');
      expect(prComments().at(-1)!.body).toContain('https://github.com/ganjardbc/umkm-pos/pull/9');
    });

    it('AC-16: an exhausted gate after approval updates the same PR too', async () => {
      writeTaskFile('requirements.md', specText('DRAFT'));
      seedState(waitingState);
      readVerifyReportMock.mockResolvedValue({ status: 'NEEDS_HUMAN', raw: 'Status: NEEDS_HUMAN' });
      (vcsClient.findOpenPullRequestByHead as ReturnType<typeof vi.fn>).mockResolvedValue({ url: 'https://github.com/ganjardbc/umkm-pos/pull/9', number: 9 });

      await makeUseCase().execute(approveJob());

      expect(vcsClient.createPullRequest).not.toHaveBeenCalled();
      expect(vcsClient.updatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 9 }));
    });

    it('AC-16: a normal run still creates its PR without looking for one first', async () => {
      plannerSpec = specText('DRAFT');

      await makeUseCase().execute(makeJob());

      expect(vcsClient.findOpenPullRequestByHead).not.toHaveBeenCalled();
      expect(vcsClient.createPullRequest).toHaveBeenCalledTimes(1);
    });
  });
});
