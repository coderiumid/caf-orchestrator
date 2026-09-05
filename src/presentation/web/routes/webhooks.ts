import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config, projectRegistry } from '../../../config/index.js';
import { verifyLinearSignature, isLinearTimestampFresh, verifyGitHubSignature } from '../../../infrastructure/vcs/security.js';
import { claimDelivery } from '../../../infrastructure/linear/delivery-dedupe.js';
import { extractTicketPrefix } from '../../../infrastructure/linear/ticket-prefix.js';
import { toJobProjectContext } from '../../../infrastructure/linear/project-context-mapper.js';
import {
  linearIssueWebhookSchema,
  githubIssueCommentSchema,
  githubPullRequestReviewCommentSchema,
  githubIssueEventSchema,
  type GithubIssueCommentPayload,
  type GithubPullRequestReviewCommentPayload,
  type GithubIssueEventPayload,
} from '../../dto/webhook.dto.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import { pipelineQueue } from '../../../infrastructure/queue/client.js';
import type { ExistingJobPayload, PrReviewCommentContext, PrReviewJobPayload } from '../../../domain/interfaces/queue.interface.js';
import { checkReviewPermission } from '../../../infrastructure/vcs/github-permission.js';
import { githubService, parseGithubRepo } from '../../../infrastructure/vcs/github.service.js';
import { resolveMaxOrchestrationRetries, type ProjectConfig } from '../../../config/project-registry.js';

// Slash-command prefixes that trigger a pr-review job from a general PR
// comment (`issue_comment`). Checked in this order because
// `/caf-fix-review` is not a prefix of `/caf-review` (or vice versa) — order
// is for readability, not correctness. No other free-text intent parsing —
// any other comment is ignored. See CAF-PRREVIEW-01 Checkpoint B decision log.
const REVIEW_AGAIN_COMMAND = '/caf-review';
const FIX_ALL_COMMAND = '/caf-fix-review';
// CAF-RETRYPIPELINE-01: resumes a gate-exhausted ticket pipeline from its
// Draft PR. Distinct string from the two above, no prefix collision either
// direction — order among the three doesn't matter for correctness.
const RETRY_PIPELINE_COMMAND = '/caf-retry-pipeline';

function splitRepoFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  return { owner, repo };
}

// GitHub Issues carry no ticket-prefix (unlike Linear identifiers), so the
// project registry — keyed by ticketPrefix — is matched here by repo instead:
// parse each registered project's repoCloneUrl (SSH or HTTPS) and compare
// owner/repo against the incoming webhook's repository.full_name.
function findProjectByGithubRepo(
  projects: ProjectConfig[],
  owner: string,
  repo: string,
): ProjectConfig | undefined {
  return projects.find((project) => {
    try {
      const parsed = parseGithubRepo(project.repoCloneUrl);
      return parsed.owner === owner && parsed.repo === repo;
    } catch {
      return false;
    }
  });
}

function unauthorized(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message });
}

async function enqueuePrReview(job: PrReviewJobPayload): Promise<string> {
  const queuedId = await pipelineQueue.addJob('pr-review', job as unknown as Record<string, unknown>);
  logger.info('PR review trigger enqueued', undefined, {
    jobId: queuedId,
    prNumber: job.prNumber,
    mode: job.mode,
  });
  return queuedId;
}

const AI_AGENT_BRANCH_PATTERN = /^ai-agent\/(.+)$/;

/**
 * `/caf-retry-pipeline` on a Draft PR — resumes a ticket pipeline that
 * stopped at a gate (CAF-RETRYPIPELINE-01 Task 4). Enforces
 * `maxOrchestrationRetries` here (permission + prefix/project lookup) so an
 * over-limit or unrecognized-branch comment gets an immediate, cheap
 * rejection without spinning up a worker job; the actual counter read/increment
 * happens once the job clones the repo (`checkAndConsumeRetryBudget` in
 * run-agent-pipeline.use-case.ts), since orchestration-state.json only exists
 * inside that clone.
 */
async function handleRetryPipelineCommand(payload: GithubIssueCommentPayload, reply: FastifyReply): Promise<FastifyReply> {
  const { owner, repo } = splitRepoFullName(payload.repository.full_name);
  const prNumber = payload.issue.number;

  // Same whitelist decision as /caf-review — CAF-RETRYPIPELINE-01
  // requirements.md explicitly defers a separate whitelist to a future ticket.
  if (!(await checkReviewPermission(owner, repo, payload.sender.login))) {
    logger.info('Retry-pipeline trigger rejected: insufficient permission', undefined, { owner, repo, username: payload.sender.login });
    return reply.status(200).send({ status: 'ignored', reason: 'ok' });
  }

  if (!config.ENABLE_PIPELINE_TRIGGER) {
    return reply.status(200).send({ status: 'disabled', reason: 'Pipeline trigger is disabled' });
  }

  const branch = await githubService.getPullRequestHeadRef(owner, repo, prNumber);
  const branchMatch = AI_AGENT_BRANCH_PATTERN.exec(branch);
  if (!branchMatch) {
    logger.info('Retry-pipeline trigger ignored: PR head branch is not an ai-agent/* branch', undefined, {
      owner,
      repo,
      prNumber,
      branch,
    });
    return reply.status(200).send({ status: 'ignored', reason: 'PR head branch is not an ai-agent/* branch' });
  }
  const ticketKey = branchMatch[1];

  const prefix = extractTicketPrefix(ticketKey);
  const project = prefix ? projectRegistry.getByPrefix(prefix) : undefined;
  if (!project) {
    logger.error('Retry-pipeline trigger: no project registered for ticket prefix', undefined, { ticketKey, prefix });
    return reply.status(200).send({ status: 'ignored', reason: 'No project registered for ticket prefix' });
  }

  const maxOrchestrationRetries = resolveMaxOrchestrationRetries(project, config.orchestration.maxOrchestrationRetries);

  const jobId = `github-retry-${randomUUID()}`;
  const jobData: ExistingJobPayload = {
    jobId,
    ticketId: ticketKey,
    ticketKey,
    // Placeholder — overwritten from orchestration-state.json once the job
    // clones the repo (checkAndConsumeRetryBudget); a resume trigger carries
    // no fresh ticket content of its own.
    ticketTitle: `Retry: ${ticketKey}`,
    ticketDescription: '',
    projectConfig: toJobProjectContext(project),
    isRetry: true,
    maxOrchestrationRetries,
    retryContext: { owner, repo, prNumber },
  };

  const queuedId = await pipelineQueue.addJob('agent-pipeline', jobData as unknown as Record<string, unknown>);

  logger.info('Retry-pipeline trigger enqueued', undefined, { jobId: queuedId, ticketKey, prNumber });

  return reply.status(202).send({ status: 'enqueued', jobId: queuedId });
}

async function handleIssueComment(payload: GithubIssueCommentPayload, reply: FastifyReply): Promise<FastifyReply> {
  // Anti-self-trigger guard, checked before anything else (including
  // slash-command matching): this route itself posts summary comments back
  // to the PR (run-pr-review.use-case.ts buildSummaryBody()) via the same
  // GITHUB_TOKEN, which GitHub then re-delivers here as a fresh issue_comment
  // event. `user.type === 'Bot'` is set by GitHub for any comment posted via
  // a bot/app token, regardless of exact username — robust to the token
  // being rotated or the bot account being renamed. Without this, a comment
  // that happens to also match a slash command (or a future reply format
  // that does) would re-trigger the pipeline on its own output.
  if (payload.comment.user.type === 'Bot') {
    logger.info('Ignoring issue_comment posted by a bot account (anti-self-trigger guard)', undefined, {
      commentId: payload.comment.id,
      login: payload.comment.user.login,
    });
    return reply.status(200).send({ status: 'ignored', reason: 'Comment posted by a bot account' });
  }

  if (payload.action !== 'created') {
    return reply.status(200).send({ status: 'ignored', reason: `issue_comment action not handled: ${payload.action}` });
  }

  if (!payload.issue.pull_request) {
    return reply.status(200).send({ status: 'ignored', reason: 'Comment is on a plain issue, not a PR' });
  }

  const body = payload.comment.body.trim();

  if (body.startsWith(RETRY_PIPELINE_COMMAND)) {
    return handleRetryPipelineCommand(payload, reply);
  }

  const mode = body.startsWith(FIX_ALL_COMMAND) ? 'global' : body.startsWith(REVIEW_AGAIN_COMMAND) ? 'initial' : undefined;
  if (!mode) {
    return reply.status(200).send({ status: 'ignored', reason: 'Comment does not start with a recognized slash command' });
  }

  const { owner, repo } = splitRepoFullName(payload.repository.full_name);
  const prNumber = payload.issue.number;

  if (!(await checkReviewPermission(owner, repo, payload.sender.login))) {
    logger.info('PR review trigger rejected: insufficient permission', undefined, { owner, repo, username: payload.sender.login });
    return reply.status(200).send({ status: 'ignored', reason: 'ok' });
  }

  if (!config.ENABLE_PIPELINE_TRIGGER) {
    return reply.status(200).send({ status: 'disabled', reason: 'Pipeline trigger is disabled' });
  }

  const prHeadBranch = await githubService.getPullRequestHeadRef(owner, repo, prNumber);

  let commentContext: PrReviewCommentContext[];
  if (mode === 'global') {
    const [reviewComments, issueComments] = await Promise.all([
      githubService.listReviewComments(owner, repo, prNumber),
      githubService.listIssueComments(owner, repo, prNumber),
    ]);

    // Thread carried as one unit (caf-initiator fix-review-command.js spawnSection,
    // "...sebagai satu unit kalau ber-reply") — only thread-starters (no
    // in_reply_to_id) are carried; reply-thread history
    // aggregation is left to caf-reviewer.md itself (Checkpoint A's spawnSection
    // contract only guarantees full-history for the interactive SCOPED path, not
    // this webhook GLOBAL path — no fetch-and-join of reply chains here).
    const inlineEntries: PrReviewCommentContext[] = reviewComments
      .filter((c) => c.inReplyToId === undefined)
      .map((c) => ({ id: c.id, label: 'INLINE', body: c.body, path: c.path, line: c.line ?? undefined }));

    // Exclude the triggering comment itself — it's the command, not feedback.
    const generalEntries: PrReviewCommentContext[] = issueComments
      .filter((c) => c.id !== payload.comment.id)
      .map((c) => ({ id: c.id, label: 'GENERAL', body: c.body }));

    commentContext = [...inlineEntries, ...generalEntries];
  } else {
    // mode 'initial' — the triggering comment (e.g. "/caf-review") is a command,
    // not feedback to respond to. Empty commentContext signals "no specific
    // comment, do a full review" to buildReviewerPrompt().
    commentContext = [];
  }

  const job: PrReviewJobPayload = {
    jobId: `github-${randomUUID()}`,
    repoFullName: payload.repository.full_name,
    cloneUrl: `https://github.com/${payload.repository.full_name}.git`,
    prNumber,
    prHeadBranch,
    mode,
    commentContext,
  };

  const queuedId = await enqueuePrReview(job);
  return reply.status(202).send({ status: 'enqueued', jobId: queuedId });
}

async function handlePullRequestReviewComment(
  payload: GithubPullRequestReviewCommentPayload,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (payload.action !== 'created') {
    return reply.status(200).send({ status: 'ignored', reason: `pull_request_review_comment action not handled: ${payload.action}` });
  }

  // Falsy check, NOT strict null check — `in_reply_to_id` is absent (not null)
  // for a thread-starter comment in the real webhook payload, unlike the REST
  // resource which explicitly sets it to null. See plan-checkpoint-b.md poin 0.
  if (!payload.comment.in_reply_to_id) {
    return reply.status(200).send({ status: 'ignored', reason: 'Thread-starter comment without a reply is not a trigger' });
  }

  const { owner, repo } = splitRepoFullName(payload.repository.full_name);

  if (!(await checkReviewPermission(owner, repo, payload.sender.login))) {
    logger.info('PR review trigger rejected: insufficient permission', undefined, { owner, repo, username: payload.sender.login });
    return reply.status(200).send({ status: 'ignored', reason: 'ok' });
  }

  if (!config.ENABLE_PIPELINE_TRIGGER) {
    return reply.status(200).send({ status: 'disabled', reason: 'Pipeline trigger is disabled' });
  }

  const job: PrReviewJobPayload = {
    jobId: `github-${randomUUID()}`,
    repoFullName: payload.repository.full_name,
    cloneUrl: `https://github.com/${payload.repository.full_name}.git`,
    prNumber: payload.pull_request.number,
    prHeadBranch: payload.pull_request.head.ref,
    mode: 'scoped',
    commentContext: [
      {
        id: payload.comment.id,
        label: 'INLINE',
        body: payload.comment.body,
        path: payload.comment.path,
        line: payload.comment.line ?? payload.comment.original_line ?? undefined,
      },
    ],
  };

  const queuedId = await enqueuePrReview(job);
  return reply.status(202).send({ status: 'enqueued', jobId: queuedId });
}

async function handleIssuesEvent(payload: GithubIssueEventPayload, reply: FastifyReply): Promise<FastifyReply> {
  if (payload.action !== 'labeled') {
    return reply.status(200).send({ status: 'ignored', reason: `issues action not handled: ${payload.action}` });
  }

  if (payload.label?.name !== config.github.readyLabel) {
    return reply.status(200).send({ status: 'ignored', reason: 'Label does not match github.readyLabel' });
  }

  const { owner, repo } = splitRepoFullName(payload.repository.full_name);

  if (!(await checkReviewPermission(owner, repo, payload.sender.login))) {
    logger.info('GitHub Issue pipeline trigger rejected: insufficient permission', undefined, { owner, repo, username: payload.sender.login });
    return reply.status(200).send({ status: 'ignored', reason: 'ok' });
  }

  if (!config.ENABLE_PIPELINE_TRIGGER) {
    return reply.status(200).send({ status: 'disabled', reason: 'Pipeline trigger is disabled' });
  }

  const project = findProjectByGithubRepo(projectRegistry.getAll(), owner, repo);
  if (!project) {
    logger.error('No project registered for GitHub repo', undefined, { owner, repo });
    return reply.status(200).send({ status: 'ignored', reason: 'No project registered for repo' });
  }

  const jobId = `github-issue-${randomUUID()}`;
  const ticketKey = `${project.ticketPrefix}-${payload.issue.number}`;
  const jobData: ExistingJobPayload = {
    jobId,
    ticketId: String(payload.issue.number),
    ticketKey,
    ticketTitle: payload.issue.title,
    ticketDescription: payload.issue.body ?? '',
    projectConfig: toJobProjectContext(project),
    ticketSource: 'github',
  };

  const queuedId = await pipelineQueue.addJob('agent-pipeline', jobData as unknown as Record<string, unknown>);

  logger.info('GitHub Issue ready-for-AI trigger enqueued', undefined, {
    jobId: queuedId,
    ticketKey,
  });

  return reply.status(202).send({ status: 'enqueued', jobId: queuedId });
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/linear', async (request, reply) => {
    if (!verifyLinearSignature(request.rawBody, request.headers['linear-signature'] as string | undefined, config.LINEAR_WEBHOOK_SECRET)) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid webhook signature.',
      });
    }

    if (!isLinearTimestampFresh(request.headers['linear-timestamp'] as string | undefined, config.linear.webhookTimestampToleranceMs)) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Webhook timestamp outside tolerance window.',
      });
    }

    const deliveryId = request.headers['linear-delivery'] as string | undefined;
    if (!deliveryId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Missing Linear-Delivery header.',
      });
    }

    const isNewDelivery = await claimDelivery('linear', deliveryId, config.linear.deliveryDedupeTtlSeconds);
    if (!isNewDelivery) {
      return reply.status(200).send({ status: 'ignored', reason: 'Duplicate delivery' });
    }

    const parsed = linearIssueWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(200).send({ status: 'ignored', reason: 'Payload not a recognized Issue event' });
    }

    const payload = parsed.data;

    const isReadyForAi =
      payload.action === 'update' &&
      payload.type === 'Issue' &&
      payload.updatedFrom !== undefined &&
      Object.hasOwn(payload.updatedFrom, 'stateId') &&
      payload.data.stateId === config.linear.readyStateId;

    if (!isReadyForAi) {
      return reply.status(200).send({ status: 'ignored', reason: 'Not a transition to Ready for AI' });
    }

    if (!config.ENABLE_PIPELINE_TRIGGER) {
      return reply.status(200).send({ status: 'disabled', reason: 'Pipeline trigger is disabled' });
    }

    const prefix = extractTicketPrefix(payload.data.identifier);
    const projectConfig = prefix ? projectRegistry.getByPrefix(prefix) : undefined;

    if (!projectConfig) {
      logger.error('No project registered for ticket prefix', undefined, {
        identifier: payload.data.identifier,
        prefix,
      });
      return reply.status(200).send({ status: 'ignored', reason: 'No project registered for ticket prefix' });
    }

    // CAF-RETRYPIPELINE-01 Task 5: a ticket re-entering "Ready for AI" whose
    // ai-agent/{ticketKey} branch already exists (from an earlier gate
    // exhaustion) is a resume, not a new ticket — route it through the exact
    // same isRetry/retryContext/checkAndConsumeRetryBudget path as Task 4's
    // /caf-retry-pipeline, sharing its counter and its NOT-gate-aware
    // (full-restart) resume behavior. See CLAUDE.md's "/caf-retry-pipeline
    // resume" section.
    const { owner: ghOwner, repo: ghRepo } = parseGithubRepo(projectConfig.repoCloneUrl);
    const retryBranch = `ai-agent/${payload.data.identifier}`;
    const isResume = await githubService.branchExists(ghOwner, ghRepo, retryBranch);

    if (isResume) {
      const openPr = await githubService.findOpenPullRequestByHead({ owner: ghOwner, repo: ghRepo, head: retryBranch });
      const maxOrchestrationRetries = resolveMaxOrchestrationRetries(projectConfig, config.orchestration.maxOrchestrationRetries);

      const resumeJobId = `linear-retry-${randomUUID()}`;
      const resumeJobData: ExistingJobPayload = {
        jobId: resumeJobId,
        ticketId: payload.data.id,
        ticketKey: payload.data.identifier,
        ticketTitle: payload.data.title,
        ticketDescription: payload.data.description ?? '',
        projectConfig: toJobProjectContext(projectConfig),
        isRetry: true,
        maxOrchestrationRetries,
        retryContext: openPr ? { owner: ghOwner, repo: ghRepo, prNumber: openPr.number } : undefined,
      };

      const queuedResumeId = await pipelineQueue.addJob('agent-pipeline', resumeJobData as unknown as Record<string, unknown>);

      logger.info('Linear ticket re-entered Ready for AI on an existing branch — resuming', undefined, {
        jobId: queuedResumeId,
        ticketKey: payload.data.identifier,
        branch: retryBranch,
        hasOpenPr: !!openPr,
      });

      return reply.status(202).send({ status: 'enqueued', jobId: queuedResumeId });
    }

    const jobId = `linear-${randomUUID()}`;
    const jobData: ExistingJobPayload = {
      jobId,
      ticketId: payload.data.id,
      ticketKey: payload.data.identifier,
      ticketTitle: payload.data.title,
      ticketDescription: payload.data.description ?? '',
      projectConfig: toJobProjectContext(projectConfig),
    };

    const queuedId = await pipelineQueue.addJob('agent-pipeline', jobData as unknown as Record<string, unknown>);

    logger.info('Linear ticket ready-for-AI trigger enqueued', undefined, {
      jobId: queuedId,
      ticketKey: payload.data.identifier,
    });

    return reply.status(202).send({ status: 'enqueued', jobId: queuedId });
  });

  app.post('/github', async (request, reply) => {
    if (!verifyGitHubSignature(request.rawBody, request.headers['x-hub-signature-256'] as string | undefined, config.GITHUB_WEBHOOK_SECRET)) {
      return unauthorized(reply, 'Invalid webhook signature.');
    }

    const deliveryId = request.headers['x-github-delivery'] as string | undefined;
    if (!deliveryId) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Missing X-GitHub-Delivery header.',
      });
    }

    const isNewDelivery = await claimDelivery('github', deliveryId, config.github.deliveryDedupeTtlSeconds);
    if (!isNewDelivery) {
      return reply.status(200).send({ status: 'ignored', reason: 'Duplicate delivery' });
    }

    const eventType = request.headers['x-github-event'] as string | undefined;

    // GitHub sends this when the webhook is first configured — must be
    // acknowledged with 2xx or the webhook shows as failing in the GitHub UI.
    // Confirmed in a real capture, see plan-checkpoint-b.md poin 0.
    if (eventType === 'ping') {
      return reply.status(200).send({ status: 'ok', reason: 'ping' });
    }

    if (eventType === 'issue_comment') {
      const parsed = githubIssueCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(200).send({ status: 'ignored', reason: 'Payload not a recognized issue_comment event' });
      }
      return handleIssueComment(parsed.data, reply);
    }

    if (eventType === 'pull_request_review_comment') {
      const parsed = githubPullRequestReviewCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(200).send({ status: 'ignored', reason: 'Payload not a recognized pull_request_review_comment event' });
      }
      return handlePullRequestReviewComment(parsed.data, reply);
    }

    if (eventType === 'issues') {
      const parsed = githubIssueEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(200).send({ status: 'ignored', reason: 'Payload not a recognized issues event' });
      }
      return handleIssuesEvent(parsed.data, reply);
    }

    // `pull_request_review` is intentionally NOT subscribed/handled — descoped,
    // see plan-checkpoint-b.md §3 and caf-initiator open-items.md.
    logger.info('Ignoring unsubscribed GitHub event type', undefined, { eventType });
    return reply.status(200).send({ status: 'ignored', reason: `Event type not handled: ${eventType}` });
  });
}
