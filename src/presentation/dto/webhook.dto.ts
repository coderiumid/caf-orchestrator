import { z } from 'zod';

/**
 * Linear "data change" webhook payload. Shape mirrors the underlying
 * GraphQL entity — see linear-webhook-signature-research.md. Only the
 * fields the orchestrator needs are validated; the rest of `data` is
 * passed through untyped.
 */
export const linearIssueWebhookSchema = z.object({
  action: z.enum(['create', 'update', 'remove']),
  type: z.string(),
  data: z.object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    stateId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
  }).passthrough(),
  updatedFrom: z.record(z.string(), z.unknown()).optional(),
  webhookTimestamp: z.number().optional(),
});

export type LinearIssueWebhookPayload = z.infer<typeof linearIssueWebhookSchema>;

/**
 * GitHub `issue_comment` webhook payload — fires for comments on both plain
 * issues and PRs (a PR is an issue in GitHub's API), disambiguated by
 * `issue.pull_request` being present. Shape confirmed against real webhook
 * deliveries, see caf-orchestrator/.ai/tasks/CAF-PRREVIEW-01/plan-checkpoint-b.md
 * poin 0.
 */
export const githubIssueCommentSchema = z.object({
  action: z.string(),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    // `user.type === 'Bot'` for comments posted via a bot/app token — used to
    // guard against processing the orchestrator's own posted comments as a
    // new trigger. See webhooks.ts handleIssueComment().
    user: z.object({
      login: z.string().min(1),
      type: z.string(),
    }).passthrough(),
  }).passthrough(),
  issue: z.object({
    number: z.number(),
    pull_request: z.unknown().optional(),
  }).passthrough(),
  repository: z.object({
    full_name: z.string().min(1),
  }).passthrough(),
  sender: z.object({
    login: z.string().min(1),
  }).passthrough(),
}).passthrough();

export type GithubIssueCommentPayload = z.infer<typeof githubIssueCommentSchema>;

/**
 * GitHub `pull_request_review_comment` webhook payload — inline, per-line
 * review comments. `comment.in_reply_to_id` is absent (not null) for a
 * thread-starter comment — falsy-check it, never strict-null-check (see
 * plan-checkpoint-b.md poin 0 nuance).
 */
export const githubPullRequestReviewCommentSchema = z.object({
  action: z.string(),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    path: z.string(),
    line: z.number().nullable().optional(),
    original_line: z.number().nullable().optional(),
    in_reply_to_id: z.number().optional(),
  }).passthrough(),
  pull_request: z.object({
    number: z.number(),
    head: z.object({
      ref: z.string().min(1),
    }).passthrough(),
  }).passthrough(),
  repository: z.object({
    full_name: z.string().min(1),
  }).passthrough(),
  sender: z.object({
    login: z.string().min(1),
  }).passthrough(),
}).passthrough();

export type GithubPullRequestReviewCommentPayload = z.infer<typeof githubPullRequestReviewCommentSchema>;
