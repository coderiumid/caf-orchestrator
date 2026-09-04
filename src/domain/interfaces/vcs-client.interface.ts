export interface CreatePullRequestInput {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface CreatePullRequestResult {
  url: string;
  number: number;
}

export interface ReplyToReviewCommentInput {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  body: string;
}

export interface PostIssueCommentInput {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

// event names match the GitHub REST API's `pulls/{number}/reviews` POST
// contract exactly (APPROVE/REQUEST_CHANGES/COMMENT) — see review-command.js
// (caf-initiator) mapping table, which run-pr-review.use-case.ts mirrors.
export type PullRequestReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface CreatePullRequestReviewInput {
  owner: string;
  repo: string;
  prNumber: number;
  event: PullRequestReviewEvent;
  body: string;
}

export interface CreatePullRequestReviewResult {
  url: string;
  id: number;
}

export interface IVcsClient {
  createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult>;
  replyToReviewComment(input: ReplyToReviewCommentInput): Promise<void>;
  postIssueComment(input: PostIssueCommentInput): Promise<void>;
  // Throws SelfReviewRejectedError (domain/errors/app-errors.ts) instead of
  // GithubApiError specifically for the self-review 422 case — see that
  // class's doc comment. Any other failure (including other 422 causes)
  // throws GithubApiError as usual.
  createPullRequestReview(input: CreatePullRequestReviewInput): Promise<CreatePullRequestReviewResult>;
}
