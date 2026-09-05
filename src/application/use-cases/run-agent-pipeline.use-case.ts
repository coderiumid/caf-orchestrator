import { existsSync } from 'node:fs';
import type { IGitService, IWorkspaceManager, WorkspacePurpose } from '../../domain/interfaces/git.interface.js';
import { WorkspaceLockError } from '../../domain/errors/app-errors.js';
import type { IAgentRunner } from '../../domain/interfaces/agent-runner.interface.js';
import type { ILinearClient } from '../../domain/interfaces/linear-client.interface.js';
import type { INotifier } from '../../domain/interfaces/notifier.interface.js';
import type { IVcsClient, CreatePullRequestResult } from '../../domain/interfaces/vcs-client.interface.js';
import type { ExistingJobPayload } from '../../domain/interfaces/queue.interface.js';
import {
  routeTasks,
  hasDocsTasks,
  parseSkipDirectives,
  type TaskAgent,
  type SkippableAgent,
} from '../../infrastructure/agent/task-router.js';
import {
  readTasks,
  readVerifyReport,
  readQaReport,
  readReviewerReport,
  appendSkipNote,
  type QaReport,
  type ReviewerReport,
} from '../../infrastructure/reports/report-reader.js';
import {
  readOrchestrationState,
  recordGateFailure,
  resetOrchestrationState,
  incrementOrchestrationRetryCount,
  type OrchestrationGate,
} from '../../infrastructure/reports/orchestration-state.js';
import { parseGithubRepo } from '../../infrastructure/vcs/github.service.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { parseApiError, formatResetDelay, NonRetryableApiError } from '../../infrastructure/agent/api-error.js';
import type { AgentRunResult } from '../../domain/interfaces/agent-runner.interface.js';
import { config } from '../../config/index.js';

export interface RunAgentPipelineDeps {
  gitService: IGitService;
  workspaceManager: IWorkspaceManager;
  agentRunner: IAgentRunner;
  linearClient: ILinearClient;
  vcsClient: IVcsClient;
  notifier?: INotifier;
}

function buildPrBody(
  job: ExistingJobPayload,
  docsNote: string,
  qaReport: QaReport,
  reviewerReport: ReviewerReport,
  qualityGateWarning: string,
): string {
  const lines: string[] = [];

  if (qualityGateWarning) {
    lines.push(qualityGateWarning, '');
  }

  lines.push(
    `Ticket: ${job.ticketKey}`,
    job.ticketDescription || '',
    '',
    '## Reports',
    `- Requirements: \`.caf/tasks/${job.ticketKey}/requirements.md\``,
    `- Verify: \`.caf/tasks/${job.ticketKey}/verify-report.md\``,
    `- QA: \`.caf/tasks/${job.ticketKey}/qa-report.md\``,
    `- Review: \`.caf/tasks/${job.ticketKey}/review-notes.md\``,
    '',
    docsNote,
    '',
    qaReport.raw,
    '',
    reviewerReport.raw,
  );

  return lines.join('\n');
}

const GATE_ARTIFACT_FILE: Record<OrchestrationGate, string> = {
  implementation: 'verify-report.md',
  qa: 'qa-report.md',
  reviewer: 'review-notes.md',
};

/**
 * PR body for a gate-exhaustion Draft PR (CAF-RETRYPIPELINE-01 Task 3) —
 * reformats the one artifact the failing gate already produced
 * (verify-report.md/qa-report.md/review-notes.md), no new text generated per
 * the report-contract convention (CLAUDE.md).
 */
function buildGateExhaustionPrBody(job: ExistingJobPayload, gate: OrchestrationGate, artifactRaw: string): string {
  return [
    `Ticket: ${job.ticketKey}`,
    job.ticketDescription || '',
    '',
    `## Pipeline stopped — gate exhausted: ${gate}`,
    '',
    `Automated retries at the ${gate} gate did not pass. Work completed so far has been pushed here for human review.`,
    '',
    '## Reports',
    `- Requirements: \`.caf/tasks/${job.ticketKey}/requirements.md\``,
    `- Tasks: \`.caf/tasks/${job.ticketKey}/tasks.md\``,
    `- ${GATE_ARTIFACT_FILE[gate]}: \`.caf/tasks/${job.ticketKey}/${GATE_ARTIFACT_FILE[gate]}\``,
    '',
    artifactRaw,
  ].join('\n');
}

/**
 * Builds the PR-body warning block for a QA/Reviewer skip. Two skip reasons
 * are folded into one block (not two separate ones) since both mean the
 * same thing to a human reviewer: extra scrutiny is required on this PR.
 */
function buildQualityGateWarning(skips: Array<{ agent: 'qa' | 'reviewer'; reason: string }>): string {
  if (skips.length === 0) return '';

  const skipLines = skips.map(({ agent, reason }) => {
    const label = agent === 'qa' ? 'caf-QA Agent' : 'caf-Reviewer Agent';
    return `- ${label} tidak dijalankan (alasan: ${reason})`;
  });

  return [
    '⚠️ **Quality gate dilewati untuk PR ini**:',
    ...skipLines,
    '',
    'Review manual WAJIB lebih teliti dari biasanya.',
  ].join('\n');
}

function ms(start: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

export class RunAgentPipelineUseCase {
  constructor(private readonly deps: RunAgentPipelineDeps) {}

  /**
   * Posts a pipeline status comment back to wherever the ticket actually
   * lives — a Linear ticket by default, or the originating GitHub Issue for
   * ticketSource: 'github' jobs (owner/repo derived from the same
   * repoCloneUrl the pipeline already cloned from; issueNumber is
   * ticketId, e.g. "25" for CDR-25).
   */
  private async postTicketComment(job: ExistingJobPayload, body: string): Promise<void> {
    // CAF-RETRYPIPELINE-01: a resume run's thread of truth is the PR the
    // retry was triggered from, not the original Linear ticket/GitHub issue —
    // that's where the human who typed /caf-retry-pipeline (or re-flipped the
    // Linear ticket) is actually watching.
    if (job.retryContext) {
      const { owner, repo, prNumber } = job.retryContext;
      await this.deps.vcsClient.postIssueComment({ owner, repo, issueNumber: prNumber, body });
      return;
    }
    if (job.ticketSource === 'github') {
      const { owner, repo } = parseGithubRepo(job.projectConfig.repoCloneUrl);
      await this.deps.vcsClient.postIssueComment({ owner, repo, issueNumber: Number(job.ticketId), body });
      return;
    }
    await this.deps.linearClient.postComment(job.ticketId, body);
  }

  async execute(job: ExistingJobPayload): Promise<void> {
    const { gitService, workspaceManager, agentRunner, linearClient, vcsClient, notifier } = this.deps;

    // Fire-and-forget: don't await, don't let notification failure affect the
    // pipeline. send() internally catches all errors already.
    void notifier?.notifyPipelineStarted({
      jobId: job.jobId,
      ticketKey: job.ticketKey,
      ticketTitle: job.ticketTitle,
    });

    // Guards against a job enqueued under the pre-projectConfig payload shape
    // (cloneUrl/baseBranch at the top level, no projectConfig) still sitting in
    // Redis across a deploy of this change — drop it cleanly instead of crashing
    // on `job.projectConfig.workspaceDir` below and looping through every retry.
    if (!job.projectConfig) {
      logger.error(
        'Job payload missing projectConfig (stale pre-migration payload) — dropping without retry',
        undefined,
        { jobId: job.jobId, ticketKey: job.ticketKey },
      );
      // Linear-only: postTicketComment's GitHub path needs projectConfig.repoCloneUrl
      // to derive owner/repo, which is exactly what's missing here.
      await linearClient
        .postComment(
          job.ticketId,
          'Agent pipeline could not start: this job was queued with an outdated payload format. Please retrigger the ticket.',
        )
        .catch((err) => logger.error('Failed to post stale-payload comment', err, { jobId: job.jobId }));
      return;
    }

    const jobStart = process.hrtime.bigint();
    const workspaceRoot = job.projectConfig.workspaceDir;
    // CAF-WSMODE-01: explicit per-call purpose — persistent-mode reuse must
    // never apply to RunPrReviewUseCase just because config.workspace.mode
    // is set globally (see WorkspacePurpose doc comment).
    const workspacePurpose: WorkspacePurpose = 'ticket-pipeline';
    const { repo: repoIdentifier } = parseGithubRepo(job.projectConfig.repoCloneUrl);

    let workspacePath: string;
    try {
      workspacePath = await workspaceManager.createWorkspace(workspaceRoot, workspacePurpose, repoIdentifier);
    } catch (err) {
      if (err instanceof WorkspaceLockError) {
        logger.info('Workspace busy, stopping pipeline for human retry', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          repoIdentifier,
        });
        await this.postTicketComment(
          job,
          `Agent pipeline could not start: this repo's persistent workspace is busy with another job. Please retry once that job finishes.`,
        );
        return;
      }
      throw err;
    }

    const repoPath = `${workspacePath}/repo`;
    const branch = `ai-agent/${job.ticketKey}`;

    logger.info('Agent pipeline started', undefined, {
      jobId: job.jobId,
      ticketKey: job.ticketKey,
      branch,
    });

    try {
      if (job.isRetry) {
        // CAF-RETRYPIPELINE-01: resume onto the EXISTING ai-agent branch
        // (already pushed by the run that exhausted a gate) instead of
        // branching fresh off baseBranch — reusing preflightCleanup with the
        // ticket branch as its "base" fetches + hard-resets the workspace to
        // origin/<branch>, and clone() already supports checking out an
        // arbitrary branch directly. This is only the minimal sync needed to
        // avoid a non-fast-forward push on retry; it does NOT do Task 6's
        // manual-change diffing or uncommitted-residue detection — those
        // still don't exist yet.
        if (existsSync(`${repoPath}/.git`)) {
          await gitService.preflightCleanup(repoPath, branch, workspaceRoot);
        } else {
          await gitService.clone(job.projectConfig.repoCloneUrl, branch, repoPath, workspaceRoot);
        }
      } else {
        // CAF-WSMODE-01: a persistent workspace already holding a prior job's
        // clone (existsSync check, not a hidden mode branch) gets fetched +
        // reset instead of cloned fresh; first run / ephemeral mode clones as
        // before.
        if (existsSync(`${repoPath}/.git`)) {
          await gitService.preflightCleanup(repoPath, job.projectConfig.baseBranch, workspaceRoot);
        } else {
          await gitService.clone(job.projectConfig.repoCloneUrl, job.projectConfig.baseBranch, repoPath, workspaceRoot);
        }
        await gitService.createBranch(repoPath, branch, workspaceRoot);
      }

      if (job.isRetry) {
        const retryGate = await this.checkAndConsumeRetryBudget(repoPath, job);
        if (!retryGate.allowed) {
          return;
        }
      }

      const plannerPrompt = [
        `Ticket ${job.ticketKey}: ${job.ticketTitle}`,
        '',
        job.ticketDescription || '(no description provided)',
      ].join('\n');

      void notifier?.notifyAgentStarted({ jobId: job.jobId, ticketKey: job.ticketKey, agentName: 'caf-planner' });
      const plannerResult = await agentRunner.run(
        'caf-planner',
        repoPath,
        plannerPrompt,
        job.projectConfig.agents.modelOverrides['caf-planner'],
      );
      logger.info('caf-planner agent run result', undefined, {
        jobId: job.jobId,
        ticketKey: job.ticketKey,
        agentName: 'caf-planner',
        exitCode: plannerResult.exitCode,
        signal: plannerResult.signal,
        timedOut: plannerResult.timedOut,
        stdout: plannerResult.stdout,
        stderr: plannerResult.stderr,
      });
      if (plannerResult.signal || plannerResult.exitCode !== 0) {
        logger.error('caf-planner agent run failed', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          agentName: 'caf-planner',
          exitCode: plannerResult.exitCode,
          signal: plannerResult.signal,
          timedOut: plannerResult.timedOut,
          stdout: plannerResult.stdout,
          stderr: plannerResult.stderr,
        });
      }
      if (plannerResult.signal) {
        throw new Error(`caf-planner agent killed by signal ${plannerResult.signal}`);
      }
      if (plannerResult.exitCode !== 0) {
        await this.stopIfNonRetryable('caf-planner', plannerResult, job);
        throw new Error(`caf-planner agent exited with code ${plannerResult.exitCode}: ${plannerResult.stderr}`);
      }

      const tasksMarkdown = await readTasks(repoPath, job.ticketKey);
      if (!tasksMarkdown) {
        // Log agent output at ERROR level so it's visible even when INFO is filtered.
        // A silent exit-0 without producing tasks.md is the hardest failure to debug.
        logger.error('caf-planner exited 0 but did not produce tasks.md', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          stdout: plannerResult.stdout,
          stderr: plannerResult.stderr,
        });
        throw new Error('caf-planner did not produce tasks.md');
      }

      // Empty map when the flag is off — every .get() below then resolves to
      // undefined, so nothing downstream can behave differently from before
      // dynamic agent skip existed. See AGENT_SKIP_ENABLED in config/schema.ts.
      const skipDirectives = config.AGENT_SKIP_ENABLED
        ? parseSkipDirectives(tasksMarkdown)
        : new Map<SkippableAgent, string>();

      const routedAgents = routeTasks(tasksMarkdown, { strictEmptyCheck: config.AGENT_SKIP_ENABLED });
      if (routedAgents.length === 0) {
        throw new Error('No Frontend Tasks or Backend Tasks section found in tasks.md (caf-frontend/caf-backend)');
      }

      const skippedImplementationAgents: Array<{ agent: TaskAgent; reason: string }> = [];
      let agentsToRun: TaskAgent[] = routedAgents;

      const wouldSkipEveryRoutedAgent = routedAgents.every((agent) => skipDirectives.has(agent));
      if (wouldSkipEveryRoutedAgent) {
        // Safety net, not the common case: skipping every implementation agent
        // would leave nothing to implement the ticket at all. Fail-safe wins
        // over honoring the directive — run everything routeTasks() found,
        // same as if no Skip Agents section existed.
        logger.warn(
          'Skip directives would skip every routed implementation agent — ignoring for safety, running all',
          undefined,
          { jobId: job.jobId, ticketKey: job.ticketKey, routedAgents },
        );
      } else {
        agentsToRun = routedAgents.filter((agent) => {
          const reason = skipDirectives.get(agent);
          if (reason === undefined) return true;
          skippedImplementationAgents.push({ agent, reason });
          return false;
        });
      }

      for (const { agent, reason } of skippedImplementationAgents) {
        logger.info(`${agent} agent skipped by explicit Planner directive`, undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          reason,
        });
        await notifier?.notifyAgentSkipped({ jobId: job.jobId, ticketKey: job.ticketKey, agentName: agent, reason });
      }

      const implementationPrompt = `Implement your assigned section of .caf/tasks/${job.ticketKey}/tasks.md for ticket ${job.ticketKey}.`;

      await this.runImplementationAgents(agentsToRun, repoPath, implementationPrompt, job);

      const verifyReport = await readVerifyReport(repoPath, job.ticketKey);
      if (!verifyReport) {
        throw new Error('No verify-report.md produced');
      }

      if (skippedImplementationAgents.length > 0) {
        await appendSkipNote(
          repoPath,
          job.ticketKey,
          skippedImplementationAgents.map(({ agent, reason }) => `- ${agent}: SKIPPED — ${reason}`),
        );
      }

      if (verifyReport.status === 'NEEDS_HUMAN') {
        await this.recordGateExhaustion(repoPath, job, 'implementation');
        const pushResult = await this.pushAndOpenGatePr(repoPath, job, branch, 'implementation', verifyReport.raw);
        await this.postTicketComment(
          job,
          this.appendPushResultNote(`Agent pipeline needs human review:\n\n${verifyReport.raw}`, pushResult),
        );
        logger.info('Pipeline stopped: verify-report reported NEEDS_HUMAN', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
        });
        await notifier?.notifyPipelineNeedsHuman({
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          reason: 'verify-report.md reported NEEDS_HUMAN (implementation agent)',
        });
        return;
      }

      const qaSkipReason = skipDirectives.get('qa');
      let qaReport: QaReport;
      if (qaSkipReason !== undefined) {
        logger.info('caf-qa agent skipped by explicit Planner directive', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          reason: qaSkipReason,
        });
        await notifier?.notifyAgentSkipped({ jobId: job.jobId, ticketKey: job.ticketKey, agentName: 'caf-qa', reason: qaSkipReason });
        qaReport = { status: 'PASS', raw: `QA Agent: SKIPPED — ${qaSkipReason}` };
      } else {
        qaReport = await this.runQaGate(repoPath, job);
      }

      let qaRetryCount = 0;

      while (qaReport.status === 'FAIL' && qaRetryCount < config.agents.qa.maxRetries) {
        qaRetryCount += 1;
        logger.info('QA failed — retrying implementation agents', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          qaRetryCount,
        });
        await this.runImplementationAgents(agentsToRun, repoPath, implementationPrompt, job);
        qaReport = await this.runQaGate(repoPath, job);
      }

      if (qaReport.status === 'FAIL') {
        await this.recordGateExhaustion(repoPath, job, 'qa');
        const pushResult = await this.pushAndOpenGatePr(repoPath, job, branch, 'qa', qaReport.raw);
        await this.postTicketComment(
          job,
          this.appendPushResultNote(`Agent pipeline needs human review (QA failed after retry):\n\n${qaReport.raw}`, pushResult),
        );
        logger.info('Pipeline stopped: QA report reported FAIL after retry', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          qaRetryCount,
        });
        await notifier?.notifyPipelineNeedsHuman({
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          reason: `QA failed after ${qaRetryCount} retry`,
        });
        return;
      }

      const reviewerSkipReason = skipDirectives.get('reviewer');
      let reviewerReport: ReviewerReport;
      if (reviewerSkipReason !== undefined) {
        logger.info('caf-reviewer agent skipped by explicit Planner directive', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          reason: reviewerSkipReason,
        });
        await notifier?.notifyAgentSkipped({
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          agentName: 'caf-reviewer',
          reason: reviewerSkipReason,
        });
        reviewerReport = { verdict: 'APPROVE', raw: `Reviewer Agent: SKIPPED — ${reviewerSkipReason}` };
      } else {
        reviewerReport = await this.runReviewerGate(repoPath, job);
      }

      let reviewerRetryCount = 0;

      while (reviewerReport.verdict === 'CHANGES_REQUESTED' && reviewerRetryCount < config.agents.reviewer.maxRetries) {
        reviewerRetryCount += 1;
        logger.info('Reviewer requested changes — retrying implementation agents', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          reviewerRetryCount,
        });
        await this.runImplementationAgents(agentsToRun, repoPath, implementationPrompt, job);
        reviewerReport = await this.runReviewerGate(repoPath, job);
      }

      if (reviewerReport.verdict === 'CHANGES_REQUESTED') {
        await this.recordGateExhaustion(repoPath, job, 'reviewer');
        const pushResult = await this.pushAndOpenGatePr(repoPath, job, branch, 'reviewer', reviewerReport.raw);
        await this.postTicketComment(
          job,
          this.appendPushResultNote(
            `Agent pipeline needs human review (reviewer requested changes after retry):\n\n${reviewerReport.raw}`,
            pushResult,
          ),
        );
        logger.info('Pipeline stopped: reviewer requested changes after retry', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          reviewerRetryCount,
        });
        await notifier?.notifyPipelineNeedsHuman({
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          reason: `Reviewer requested changes after ${reviewerRetryCount} retry`,
        });
        return;
      }

      let docsNote = 'No Docs Tasks in tasks.md — nothing to update.';
      const documentationSkipReason = skipDirectives.get('documentation');

      if (documentationSkipReason !== undefined) {
        docsNote = `Documentation agent skipped (alasan: ${documentationSkipReason}).`;
        logger.info('caf-documentation agent skipped by explicit Planner directive', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          reason: documentationSkipReason,
        });
        await notifier?.notifyAgentSkipped({
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          agentName: 'caf-documentation',
          reason: documentationSkipReason,
        });
        await appendSkipNote(repoPath, job.ticketKey, [`- documentation: SKIPPED — ${documentationSkipReason}`]);
      } else if (hasDocsTasks(tasksMarkdown)) {
        const docsPrompt = `Implement the Docs Tasks section of .caf/tasks/${job.ticketKey}/tasks.md for ticket ${job.ticketKey}.`;
        try {
          void notifier?.notifyAgentStarted({ jobId: job.jobId, ticketKey: job.ticketKey, agentName: 'caf-documentation' });
          const docsResult = await agentRunner.run(
            'caf-documentation',
            repoPath,
            docsPrompt,
            job.projectConfig.agents.modelOverrides['caf-documentation'],
          );
          logger.info('caf-documentation agent run result', undefined, {
            jobId: job.jobId,
            ticketKey: job.ticketKey,
            agentName: 'caf-documentation',
            exitCode: docsResult.exitCode,
            signal: docsResult.signal,
            timedOut: docsResult.timedOut,
            stdout: docsResult.stdout,
            stderr: docsResult.stderr,
          });
          if (docsResult.signal || docsResult.exitCode !== 0) {
            logger.error('caf-documentation agent run failed', undefined, {
              jobId: job.jobId,
              ticketKey: job.ticketKey,
              agentName: 'caf-documentation',
              exitCode: docsResult.exitCode,
              signal: docsResult.signal,
              timedOut: docsResult.timedOut,
              stdout: docsResult.stdout,
              stderr: docsResult.stderr,
            });
            docsNote = 'caf-Documentation agent failed — docs need manual update.';
          } else {
            docsNote = 'caf-Documentation agent updated docs (see diff in branch).';
          }
        } catch (docsErr) {
          // Docs Tasks are non-blocking per CAF Layer 2 — never let a docs failure
          // fail the whole job (that would trigger a full pipeline retry via BullMQ).
          logger.error(
            'caf-documentation agent threw',
            docsErr instanceof Error ? docsErr : new Error(String(docsErr)),
            { jobId: job.jobId, ticketKey: job.ticketKey },
          );
          docsNote = 'caf-Documentation agent errored — docs need manual update.';
        }
      }

      try {
        await resetOrchestrationState(repoPath, job.ticketKey);
      } catch (err) {
        logger.error('Failed to reset orchestration-state.json on pipeline success', err instanceof Error ? err : new Error(String(err)), {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
        });
      }

      await gitService.commitAll(repoPath, `AI agent pipeline: ${job.ticketKey}`, workspaceRoot);
      await gitService.push(repoPath, branch, workspaceRoot);

      const qualityGateSkips: Array<{ agent: 'qa' | 'reviewer'; reason: string }> = [];
      if (qaSkipReason !== undefined) qualityGateSkips.push({ agent: 'qa', reason: qaSkipReason });
      if (reviewerSkipReason !== undefined) qualityGateSkips.push({ agent: 'reviewer', reason: reviewerSkipReason });
      const qualityGateWarning = buildQualityGateWarning(qualityGateSkips);

      const { owner, repo } = parseGithubRepo(job.projectConfig.repoCloneUrl);
      const pullRequest = await vcsClient.createPullRequest({
        owner,
        repo,
        head: branch,
        base: job.projectConfig.baseBranch,
        title: `${job.ticketKey}: ${job.ticketTitle}`,
        body: buildPrBody(job, docsNote, qaReport, reviewerReport, qualityGateWarning),
      });
      logger.info('Pull request created', undefined, {
        jobId: job.jobId,
        ticketKey: job.ticketKey,
        prUrl: pullRequest.url,
      });

      await this.postTicketComment(
        job,
        `Agent pipeline complete. PR: ${pullRequest.url}\n\n${docsNote}\n\n${qaReport.raw}\n\n${reviewerReport.raw}`,
      );

      const totalMs = ms(jobStart);
      logger.info('Agent pipeline completed', undefined, { jobId: job.jobId, totalDurationMs: totalMs });

      await notifier?.notifyPipelineComplete({
        jobId: job.jobId,
        ticketKey: job.ticketKey,
        durationMs: totalMs,
        branch,
      });
    } catch (err) {
      if (err instanceof NonRetryableApiError) {
        // Already reported via postComment + logger.info in stopIfNonRetryable.
        // Clean stop, same as the NEEDS_HUMAN/QA/reviewer gates — no BullMQ retry.
        return;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Agent pipeline failed', err instanceof Error ? err : new Error(errorMessage), {
        jobId: job.jobId,
        ticketKey: job.ticketKey,
        totalDurationMs: ms(jobStart),
      });

      await notifier?.notifyPipelineFailed({
        jobId: job.jobId,
        ticketKey: job.ticketKey,
        errorMessage,
      });

      throw err;
    } finally {
      await workspaceManager.cleanupWorkspace(workspacePath, workspaceRoot, workspacePurpose);
    }
  }

  /**
   * Stamps orchestration-state.json with the gate that just exhausted its
   * retries (CAF-RETRYPIPELINE-01 Task 2) — read by the future resume handler
   * (Task 6) to know which agent/artifact to resume with, and by
   * /caf-retry-pipeline (Task 4) to enforce maxOrchestrationRetries. Failure
   * to read HEAD (e.g. a git error) must not crash the pipeline here — the
   * human-facing NEEDS_HUMAN comment this precedes still needs to go out.
   */
  private async recordGateExhaustion(repoPath: string, job: ExistingJobPayload, gate: OrchestrationGate): Promise<void> {
    try {
      const commitSha = await this.deps.gitService.getHeadCommit(repoPath);
      await recordGateFailure(repoPath, job.ticketKey, gate, commitSha, {
        ticketTitle: job.ticketTitle,
        ticketDescription: job.ticketDescription,
      });
    } catch (err) {
      logger.error('Failed to write orchestration-state.json on gate exhaustion', err instanceof Error ? err : new Error(String(err)), {
        jobId: job.jobId,
        ticketKey: job.ticketKey,
        gate,
      });
    }
  }

  /**
   * Gate for a resume job (`job.isRetry`) — read right after the workspace
   * has been synced onto the existing `ai-agent/{ticketKey}` branch, before
   * any agent runs. Rejects (posts an explicit comment, returns
   * `allowed: false`) when there's nothing to resume (no
   * orchestration-state.json at all — this command only makes sense on a PR
   * this orchestrator itself opened via a gate-exhaustion) or the ticket has
   * already used up `maxOrchestrationRetries`. Otherwise increments the
   * shared counter (Task 4 `/caf-retry-pipeline` and Task 5's Linear
   * re-trigger both call this same path, so they share one counter — see
   * CAF-RETRYPIPELINE-01 acceptance criteria) and refreshes
   * `job.ticketTitle`/`job.ticketDescription` from the stored state, since a
   * resume trigger carries no fresh ticket content of its own.
   */
  private async checkAndConsumeRetryBudget(
    repoPath: string,
    job: ExistingJobPayload,
  ): Promise<{ allowed: boolean }> {
    const state = await readOrchestrationState(repoPath, job.ticketKey);
    if (!state) {
      await this.postTicketComment(
        job,
        `⚠️ /caf-retry-pipeline: no prior orchestration state found for ${job.ticketKey} — nothing to resume. This command only works on a Draft PR the pipeline opened automatically after a gate stopped it.`,
      );
      logger.info('Retry rejected: no orchestration-state.json found', undefined, {
        jobId: job.jobId,
        ticketKey: job.ticketKey,
      });
      return { allowed: false };
    }

    const maxRetries = job.maxOrchestrationRetries ?? 0;
    if (state.orchestrationRetryCount >= maxRetries) {
      await this.postTicketComment(
        job,
        `🚫 Retry limit reached for ${job.ticketKey} (${state.orchestrationRetryCount}/${maxRetries}). Automatic retry is no longer available — please make changes manually or ask a maintainer to intervene.`,
      );
      logger.info('Retry rejected: orchestrationRetryCount at or above maxOrchestrationRetries', undefined, {
        jobId: job.jobId,
        ticketKey: job.ticketKey,
        orchestrationRetryCount: state.orchestrationRetryCount,
        maxRetries,
      });
      return { allowed: false };
    }

    job.ticketTitle = state.ticketTitle || job.ticketTitle;
    job.ticketDescription = state.ticketDescription || job.ticketDescription;
    const newCount = await incrementOrchestrationRetryCount(repoPath, job.ticketKey);
    logger.info('Orchestration retry allowed, counter incremented', undefined, {
      jobId: job.jobId,
      ticketKey: job.ticketKey,
      orchestrationRetryCount: newCount,
      maxRetries,
    });
    return { allowed: true };
  }

  /**
   * Commits + pushes the branch and opens (or updates, if one is already open
   * on this branch) a Draft PR when a gate exhausts its retries
   * (CAF-RETRYPIPELINE-01 Task 3) — so the work the agents already did is
   * never stranded in an ephemeral/persistent workspace only. Deliberately
   * swallows its own errors: a push/GitHub failure here must not turn a
   * NEEDS_HUMAN gate's `return` into a `throw` (that would hand the job back
   * to BullMQ's retry policy, which the "return vs throw" contract this
   * pipeline relies on explicitly forbids — see CLAUDE.md and the gate
   * exhaustion sections above). The caller surfaces the outcome (PR link or
   * failure note) in the human-facing comment instead.
   */
  private async pushAndOpenGatePr(
    repoPath: string,
    job: ExistingJobPayload,
    branch: string,
    gate: OrchestrationGate,
    artifactRaw: string,
  ): Promise<{ pr?: CreatePullRequestResult; error?: string }> {
    const { gitService, vcsClient } = this.deps;
    try {
      await gitService.commitAll(
        repoPath,
        `AI agent pipeline: ${job.ticketKey} (needs human review — ${gate} gate)`,
        job.projectConfig.workspaceDir,
      );
      await gitService.push(repoPath, branch, job.projectConfig.workspaceDir);

      const { owner, repo } = parseGithubRepo(job.projectConfig.repoCloneUrl);
      const body = buildGateExhaustionPrBody(job, gate, artifactRaw);
      const existing = await vcsClient.findOpenPullRequestByHead({ owner, repo, head: branch });

      const pr = existing
        ? await vcsClient.updatePullRequest({ owner, repo, prNumber: existing.number, body })
        : await vcsClient.createPullRequest({
            owner,
            repo,
            head: branch,
            base: job.projectConfig.baseBranch,
            title: `${job.ticketKey}: ${job.ticketTitle}`,
            body,
            draft: true,
          });

      logger.info('Pushed and opened/updated Draft PR on gate exhaustion', undefined, {
        jobId: job.jobId,
        ticketKey: job.ticketKey,
        gate,
        prUrl: pr.url,
        reusedExisting: !!existing,
      });

      return { pr };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        'Failed to push + open/update Draft PR on gate exhaustion',
        err instanceof Error ? err : new Error(errorMessage),
        { jobId: job.jobId, ticketKey: job.ticketKey, gate },
      );
      return { error: errorMessage };
    }
  }

  /** Appends the Draft PR link (or a failure note) to a gate-exhaustion comment, without disturbing the fixed prefix existing callers/tests match on. */
  private appendPushResultNote(message: string, pushResult: { pr?: CreatePullRequestResult; error?: string }): string {
    if (pushResult.pr) {
      return `${message}\n\nDraft PR: ${pushResult.pr.url}`;
    }
    if (pushResult.error) {
      return `${message}\n\n⚠️ Could not push/open a Draft PR automatically: ${pushResult.error}. Code changes remain in the workspace only — push manually or retry.`;
    }
    return message;
  }

  /**
   * Checks a failed agent run's stdout for a known non-retryable API error status.
   * If found, posts the human-facing comment and throws `NonRetryableApiError` — a
   * marker the top-level catch in `execute()` turns into a clean `return` (same
   * end-state as the NEEDS_HUMAN/QA/reviewer gates: no BullMQ retry, since retrying
   * a quota/config error immediately just repeats the same failure).
   *
   * Only status codes we've confirmed are genuinely non-retryable are handled here
   * (429 quota, 404 model-not-found). Any other/unrecognized status falls through
   * to the caller's generic `throw`, which BullMQ retries as usual — deliberately
   * not generalized to "all 4xx are non-retryable" (see audit: some 4xx, e.g. a
   * malformed-prompt 400, may be transient/worth retrying).
   */
  private async stopIfNonRetryable(agentName: string, result: AgentRunResult, job: ExistingJobPayload): Promise<void> {
    const apiError = parseApiError(result.stdout);
    if (!apiError?.status) return;

    switch (apiError.status) {
      case 429: {
        await this.postTicketComment(
          job,
          `Agent pipeline stopped: ${agentName} agent hit API quota (429). Estimated reset: ${formatResetDelay(apiError.resetDelayMs)}.`,
        );
        logger.info('Pipeline stopped: agent hit quota-exhausted (429)', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          agentName,
          resetDelayMs: apiError.resetDelayMs,
        });
        await this.deps.notifier?.notifyPipelineNeedsHuman({
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          reason: `${agentName} agent hit API quota (429), reset: ${formatResetDelay(apiError.resetDelayMs)}`,
        });
        throw new NonRetryableApiError(agentName, 429);
      }
      case 404: {
        await this.postTicketComment(
          job,
          `Agent pipeline stopped: ${agentName} agent hit model tidak ditemukan/tidak bisa diakses (404) — cek config model routing (openai.defaultModel / agents.modelOverrides / openai.allowedModels di caf.config.yaml).`,
        );
        logger.info('Pipeline stopped: agent hit model-not-found (404)', undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          agentName,
        });
        await this.deps.notifier?.notifyPipelineNeedsHuman({
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          reason: `${agentName} agent hit model-not-found (404) — check model routing config`,
        });
        throw new NonRetryableApiError(agentName, 404);
      }
      default:
        return;
    }
  }

  private async runImplementationAgents(
    agentsToRun: TaskAgent[],
    repoPath: string,
    implementationPrompt: string,
    job: ExistingJobPayload,
  ): Promise<void> {
    const { agentRunner, notifier } = this.deps;

    for (const agentName of agentsToRun) {
      void notifier?.notifyAgentStarted({ jobId: job.jobId, ticketKey: job.ticketKey, agentName });
      const result = await agentRunner.run(
        agentName,
        repoPath,
        implementationPrompt,
        job.projectConfig.agents.modelOverrides[agentName],
      );
      logger.info(`${agentName} agent run result`, undefined, {
        jobId: job.jobId,
        ticketKey: job.ticketKey,
        agentName,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (result.signal || result.exitCode !== 0) {
        logger.error(`${agentName} agent run failed`, undefined, {
          jobId: job.jobId,
          ticketKey: job.ticketKey,
          agentName,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
      if (result.signal) {
        throw new Error(`${agentName} agent killed by signal ${result.signal}`);
      }
      if (result.exitCode !== 0) {
        await this.stopIfNonRetryable(agentName, result, job);
        throw new Error(`${agentName} agent exited with code ${result.exitCode}: ${result.stderr}`);
      }
    }
  }

  private async runQaGate(repoPath: string, job: ExistingJobPayload): Promise<QaReport> {
    const { agentRunner, notifier } = this.deps;

    void notifier?.notifyAgentStarted({ jobId: job.jobId, ticketKey: job.ticketKey, agentName: 'caf-qa' });
    const qaPrompt = `Run QA against .caf/tasks/${job.ticketKey}/tasks.md for ticket ${job.ticketKey} and write .caf/tasks/${job.ticketKey}/qa-report.md.`;
    const qaResult = await agentRunner.run(
      'caf-qa',
      repoPath,
      qaPrompt,
      job.projectConfig.agents.modelOverrides['caf-qa'],
    );
    logger.info('caf-qa agent run result', undefined, {
      jobId: job.jobId,
      ticketKey: job.ticketKey,
      agentName: 'caf-qa',
      exitCode: qaResult.exitCode,
      signal: qaResult.signal,
      timedOut: qaResult.timedOut,
      stdout: qaResult.stdout,
      stderr: qaResult.stderr,
    });
    if (qaResult.signal || qaResult.exitCode !== 0) {
      logger.error('caf-qa agent run failed', undefined, {
        jobId: job.jobId,
        ticketKey: job.ticketKey,
        agentName: 'caf-qa',
        exitCode: qaResult.exitCode,
        signal: qaResult.signal,
        timedOut: qaResult.timedOut,
        stdout: qaResult.stdout,
        stderr: qaResult.stderr,
      });
    }
    if (qaResult.signal) {
      throw new Error(`qa agent killed by signal ${qaResult.signal}`);
    }
    if (qaResult.exitCode !== 0) {
      await this.stopIfNonRetryable('caf-qa', qaResult, job);
      throw new Error(`qa agent exited with code ${qaResult.exitCode}: ${qaResult.stderr}`);
    }

    const qaReport = await readQaReport(repoPath, job.ticketKey);
    if (!qaReport) {
      throw new Error('No qa-report.md produced');
    }

    return qaReport;
  }

  private async runReviewerGate(repoPath: string, job: ExistingJobPayload): Promise<ReviewerReport> {
    const { agentRunner, notifier } = this.deps;

    void notifier?.notifyAgentStarted({ jobId: job.jobId, ticketKey: job.ticketKey, agentName: 'caf-reviewer' });
    const reviewerPrompt = `Review implementasi untuk ticket ${job.ticketKey} sesuai .caf/tasks/${job.ticketKey}/ dan tulis .caf/tasks/${job.ticketKey}/review-notes.md.`;
    const reviewerResult = await agentRunner.run(
      'caf-reviewer',
      repoPath,
      reviewerPrompt,
      job.projectConfig.agents.modelOverrides['caf-reviewer'],
    );
    logger.info('caf-reviewer agent run result', undefined, {
      jobId: job.jobId,
      ticketKey: job.ticketKey,
      agentName: 'caf-reviewer',
      exitCode: reviewerResult.exitCode,
      signal: reviewerResult.signal,
      timedOut: reviewerResult.timedOut,
      stdout: reviewerResult.stdout,
      stderr: reviewerResult.stderr,
    });
    if (reviewerResult.signal || reviewerResult.exitCode !== 0) {
      logger.error('caf-reviewer agent run failed', undefined, {
        jobId: job.jobId,
        ticketKey: job.ticketKey,
        agentName: 'caf-reviewer',
        exitCode: reviewerResult.exitCode,
        signal: reviewerResult.signal,
        timedOut: reviewerResult.timedOut,
        stdout: reviewerResult.stdout,
        stderr: reviewerResult.stderr,
      });
    }
    if (reviewerResult.signal) {
      throw new Error(`reviewer agent killed by signal ${reviewerResult.signal}`);
    }
    if (reviewerResult.exitCode !== 0) {
      await this.stopIfNonRetryable('caf-reviewer', reviewerResult, job);
      throw new Error(`reviewer agent exited with code ${reviewerResult.exitCode}: ${reviewerResult.stderr}`);
    }

    const reviewerReport = await readReviewerReport(repoPath, job.ticketKey);
    if (!reviewerReport) {
      throw new Error('No review-notes.md produced');
    }

    return reviewerReport;
  }
}
