export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly statusCode = 400;
}

export class UnauthorizedError extends AppError {
  readonly code = 'UNAUTHORIZED';
  readonly statusCode = 401;
}

export class GitError extends AppError {
  readonly code = 'GIT_ERROR';
  readonly statusCode = 500;
}

export class AgentSpawnError extends AppError {
  readonly code = 'AGENT_SPAWN_ERROR';
  readonly statusCode = 502;
}

export class AgentTimeoutError extends AppError {
  readonly code = 'AGENT_TIMEOUT_ERROR';
  readonly statusCode = 504;
}

export class LinearApiError extends AppError {
  readonly code = 'LINEAR_API_ERROR';
  readonly statusCode = 502;
}

export class GithubApiError extends AppError {
  readonly code = 'GITHUB_API_ERROR';
  readonly statusCode = 502;
}

// Thrown by GithubService.createPullRequestReview() when the GitHub API
// rejects an APPROVE/REQUEST_CHANGES review with 422 because the reviewing
// actor (this pipeline's token) is also the PR author — confirmed empirically
// per caf-initiator's review-command.js (PR #83/GAN-114, 2026-08-22), distinct
// message per event. CAF-ORCH-PRREVIEW-03: caught by run-pr-review.use-case.ts
// to auto-fallback to event COMMENT with the real verdict stated in the body —
// NOT the same handling as an unrecognized/missing Verdict (that's a STOP, no
// fallback; this is the one case with a deliberate, decided fallback).
export class SelfReviewRejectedError extends AppError {
  readonly code = 'GITHUB_SELF_REVIEW_REJECTED';
  readonly statusCode = 422;
}

// Thrown when a persistent-mode workspace is already locked by another
// in-flight job (CAF-WSMODE-01) — reject-immediately behavior, not queued.
export class WorkspaceLockError extends AppError {
  readonly code = 'WORKSPACE_LOCK_ERROR';
  readonly statusCode = 409;
}
