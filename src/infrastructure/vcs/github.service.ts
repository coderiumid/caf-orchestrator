import type {
  IVcsClient,
  CreatePullRequestInput,
  CreatePullRequestResult,
  ReplyToReviewCommentInput,
  PostIssueCommentInput,
} from '../../domain/interfaces/vcs-client.interface.js';
import { GithubApiError } from '../../domain/errors/app-errors.js';
import { config } from '../../config/index.js';
import { logger } from '../logging/logger.js';

const GITHUB_REPO_PATTERN = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/;

export function parseGithubRepo(cloneUrl: string): { owner: string; repo: string } {
  const match = GITHUB_REPO_PATTERN.exec(cloneUrl);
  if (!match) {
    throw new GithubApiError(`Could not parse owner/repo from clone URL: ${cloneUrl}`);
  }
  const [, owner, repo] = match;
  return { owner, repo };
}

interface GithubPullRequestResponse {
  html_url: string;
  number: number;
}

interface GithubPullRequestDetailResponse {
  number: number;
  head: { ref: string };
}

export interface GithubReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  inReplyToId: number | undefined;
}

interface GithubReviewCommentResponse {
  id: number;
  body: string;
  path: string;
  line: number | null;
  original_line?: number | null;
  // The REST resource (GET /pulls/{number}/comments) sets this explicitly to
  // `null` for a thread-starter comment, not `undefined`/absent — declared
  // `| null` here so the raw-response type doesn't lie about the runtime shape.
  in_reply_to_id?: number | null;
}

export interface GithubIssueComment {
  id: number;
  body: string;
}

interface GithubIssueCommentResponse {
  id: number;
  body: string;
}

async function githubGet<T>(path: string): Promise<T> {
  const res = await fetch(`${config.github.apiUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${config.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!res.ok) {
    const responseBody = await res.text();
    throw new GithubApiError(`GitHub API request failed (${res.status}): ${responseBody}`);
  }

  return (await res.json()) as T;
}

export class GithubService implements IVcsClient {
  async createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    const { owner, repo, head, base, title, body } = input;

    const res = await fetch(`${config.github.apiUrl}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, head, base, body }),
    });

    if (!res.ok) {
      const responseBody = await res.text();
      throw new GithubApiError(`GitHub API request failed (${res.status}): ${responseBody}`);
    }

    const json = (await res.json()) as GithubPullRequestResponse;
    logger.info('Created GitHub pull request', undefined, { owner, repo, prNumber: json.number });

    return { url: json.html_url, number: json.number };
  }

  // Reply endpoint for an existing PR review (inline) comment thread — same one
  // used manually to confirm the contract in plan-checkpoint-b.md §0 (poin 0).
  async replyToReviewComment(input: ReplyToReviewCommentInput): Promise<void> {
    const { owner, repo, prNumber, commentId, body } = input;

    const res = await fetch(
      `${config.github.apiUrl}/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
      },
    );

    if (!res.ok) {
      const responseBody = await res.text();
      throw new GithubApiError(`GitHub API request failed (${res.status}): ${responseBody}`);
    }

    logger.info('Replied to GitHub review comment', undefined, { owner, repo, prNumber, commentId });
  }

  // General PR conversation comment (Conversation tab), not tied to a specific
  // inline review comment — used for the closing summary in plan-checkpoint-b.md §5.
  async postIssueComment(input: PostIssueCommentInput): Promise<void> {
    const { owner, repo, issueNumber, body } = input;

    const res = await fetch(`${config.github.apiUrl}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    });

    if (!res.ok) {
      const responseBody = await res.text();
      throw new GithubApiError(`GitHub API request failed (${res.status}): ${responseBody}`);
    }

    logger.info('Posted GitHub issue comment', undefined, { owner, repo, issueNumber });
  }

  // Needed by the /github route (CAF-PRREVIEW-01 Checkpoint B, Task E) to resolve
  // a PR's head branch from an `issue_comment` event, which only carries
  // `issue.number` — unlike `pull_request_review_comment`, which already embeds
  // `pull_request.head.ref`. See plan-checkpoint-b.md poin 4.
  async getPullRequestHeadRef(owner: string, repo: string, prNumber: number): Promise<string> {
    const json = await githubGet<GithubPullRequestDetailResponse>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    return json.head.ref;
  }

  // Inline (per-line) review comments — the only comment type that can anchor
  // a SCOPED fix (has path/line/in_reply_to_id). See plan.md (caf-initiator) §4.
  async listReviewComments(owner: string, repo: string, prNumber: number): Promise<GithubReviewComment[]> {
    const json = await githubGet<GithubReviewCommentResponse[]>(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`);
    return json.map((c) => ({
      id: c.id,
      body: c.body,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      // Normalize the REST resource's explicit `null` (thread-starter) to
      // `undefined` so callers can use a single `=== undefined` check,
      // consistent with the webhook payload shape (see plan-checkpoint-b.md poin 0).
      inReplyToId: c.in_reply_to_id ?? undefined,
    }));
  }

  // General PR conversation comments — no anchor, GLOBAL-fix-only. See
  // plan.md (caf-initiator) §4.
  async listIssueComments(owner: string, repo: string, prNumber: number): Promise<GithubIssueComment[]> {
    const json = await githubGet<GithubIssueCommentResponse[]>(`/repos/${owner}/${repo}/issues/${prNumber}/comments`);
    return json.map((c) => ({ id: c.id, body: c.body }));
  }
}

export const githubService = new GithubService();
