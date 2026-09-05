export interface CreatePullRequestInput {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  // Opens the PR in draft state (CAF-RETRYPIPELINE-01 gate-exhaustion path) —
  // omitted/false keeps the pre-existing ready-for-review behavior.
  draft?: boolean;
}

export interface CreatePullRequestResult {
  url: string;
  number: number;
}

export interface FindPullRequestByHeadInput {
  owner: string;
  repo: string;
  head: string;
}

export interface UpdatePullRequestInput {
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
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
  // CAF-RETRYPIPELINE-01: lets a gate-exhaustion push check for an already-open
  // PR on this branch (e.g. from an earlier gate's exhaustion in a prior run)
  // before opening a new one — undefined when none is open.
  findOpenPullRequestByHead(input: FindPullRequestByHeadInput): Promise<CreatePullRequestResult | undefined>;
  updatePullRequest(input: UpdatePullRequestInput): Promise<CreatePullRequestResult>;
}
