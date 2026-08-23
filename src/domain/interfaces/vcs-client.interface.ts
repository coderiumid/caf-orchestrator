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

export interface IVcsClient {
  createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult>;
  replyToReviewComment(input: ReplyToReviewCommentInput): Promise<void>;
  postIssueComment(input: PostIssueCommentInput): Promise<void>;
}
