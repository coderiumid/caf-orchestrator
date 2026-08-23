import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SECRET = 'test-github-webhook-secret';

const configMock = {
  GITHUB_WEBHOOK_SECRET: SECRET,
  ENABLE_PIPELINE_TRIGGER: true,
  github: {
    apiUrl: 'https://api.github.com',
    deliveryDedupeTtlSeconds: 86_400,
  },
  dashboard: { enabled: false },
};

const addJobMock = vi.fn().mockResolvedValue('job-1');
const claimDeliveryMock = vi.fn().mockResolvedValue(true);
const checkReviewPermissionMock = vi.fn().mockResolvedValue(true);
const getPullRequestHeadRefMock = vi.fn().mockResolvedValue('ai-agent/CAF-PRREVIEW-01');
const listReviewCommentsMock = vi.fn().mockResolvedValue([]);
const listIssueCommentsMock = vi.fn().mockResolvedValue([]);

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
  projectRegistry: {},
}));

vi.mock('../../src/infrastructure/queue/client.js', () => ({
  pipelineQueue: { addJob: addJobMock, close: vi.fn() },
  rawPipelineQueue: {},
}));

vi.mock('../../src/infrastructure/linear/delivery-dedupe.js', () => ({
  claimDelivery: claimDeliveryMock,
}));

vi.mock('../../src/infrastructure/vcs/github-permission.js', () => ({
  checkReviewPermission: checkReviewPermissionMock,
}));

vi.mock('../../src/infrastructure/vcs/github.service.js', () => ({
  githubService: {
    getPullRequestHeadRef: getPullRequestHeadRefMock,
    listReviewComments: listReviewCommentsMock,
    listIssueComments: listIssueCommentsMock,
  },
}));

function signBody(rawBody: string, secret: string = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function inject(
  body: unknown,
  eventType: string,
  headers: Record<string, string> = {},
) {
  const { buildApp } = await import('../../src/presentation/web/app.js');
  const app = buildApp();
  const rawBody = JSON.stringify(body);
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/github',
    payload: rawBody,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signBody(rawBody),
      'x-github-delivery': `delivery-${Math.random()}`,
      'x-github-event': eventType,
      ...headers,
    },
  });
  await app.close();
  return response;
}

// Fixture shapes based on the real payload structure captured in
// plan-checkpoint-b.md poin 0.
function issueCommentPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    comment: { id: 1001, body: '/caf-fix-review', user: { login: 'ganjardbc', type: 'User' } },
    issue: { number: 42, pull_request: { url: 'https://api.github.com/.../pulls/42' } },
    repository: { full_name: 'ganjardbc/umkm-pos' },
    sender: { login: 'ganjardbc' },
    ...overrides,
  };
}

function prReviewCommentPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    comment: {
      id: 3809805822,
      body: 'please fix this',
      path: 'apps/api/src/health/health.controller.ts',
      line: 7,
      in_reply_to_id: 3809805821,
    },
    pull_request: { number: 42, head: { ref: 'ai-agent/CAF-PRREVIEW-01' } },
    repository: { full_name: 'ganjardbc/umkm-pos' },
    sender: { login: 'ganjardbc' },
    ...overrides,
  };
}

describe('github webhook routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addJobMock.mockResolvedValue('job-1');
    claimDeliveryMock.mockResolvedValue(true);
    checkReviewPermissionMock.mockResolvedValue(true);
    getPullRequestHeadRefMock.mockResolvedValue('ai-agent/CAF-PRREVIEW-01');
    listReviewCommentsMock.mockResolvedValue([]);
    listIssueCommentsMock.mockResolvedValue([]);
  });

  it('acknowledges ping with 200 and does not enqueue', async () => {
    const response = await inject({ zen: 'hello' }, 'ping');
    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature before touching routing logic', async () => {
    const response = await inject(issueCommentPayload(), 'issue_comment', {
      'x-hub-signature-256': 'sha256=deadbeef',
    });
    expect(response.statusCode).toBe(401);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('ignores a duplicate delivery before reaching routing logic', async () => {
    claimDeliveryMock.mockResolvedValueOnce(false);
    const response = await inject(issueCommentPayload(), 'issue_comment');
    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('ignores an unsubscribed event type (pull_request_review)', async () => {
    const response = await inject({ action: 'submitted' }, 'pull_request_review');
    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  describe('issue_comment', () => {
    it('ignores a comment on a plain issue (no pull_request field)', async () => {
      const response = await inject(issueCommentPayload({ issue: { number: 1, pull_request: undefined } }), 'issue_comment');
      expect(response.statusCode).toBe(200);
      expect(addJobMock).not.toHaveBeenCalled();
    });

    it('ignores a comment without a recognized slash command', async () => {
      const response = await inject(issueCommentPayload({ comment: { id: 1, body: 'nice work!', user: { login: 'ganjardbc', type: 'User' } } }), 'issue_comment');
      expect(response.statusCode).toBe(200);
      expect(addJobMock).not.toHaveBeenCalled();
    });

    it('enqueues a global-mode pr-review job for /caf-fix-review', async () => {
      const response = await inject(issueCommentPayload({ comment: { id: 1, body: '/caf-fix-review', user: { login: 'ganjardbc', type: 'User' } } }), 'issue_comment');
      expect(response.statusCode).toBe(202);
      expect(addJobMock).toHaveBeenCalledTimes(1);
      const [name, jobData] = addJobMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(name).toBe('pr-review');
      expect(jobData.mode).toBe('global');
      expect(jobData.prHeadBranch).toBe('ai-agent/CAF-PRREVIEW-01');
    });

    it('enqueues an initial-mode pr-review job for /caf-review', async () => {
      const response = await inject(issueCommentPayload({ comment: { id: 1, body: '/caf-review please', user: { login: 'ganjardbc', type: 'User' } } }), 'issue_comment');
      expect(response.statusCode).toBe(202);
      const [, jobData] = addJobMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(jobData.mode).toBe('initial');
    });

    it('does not carry the trigger comment itself as commentContext for initial mode', async () => {
      // The "/caf-review" comment is a command, not feedback to respond to —
      // commentContext must be empty so buildReviewerPrompt() knows to do a
      // full review instead of "responding" to the trigger text.
      const response = await inject(issueCommentPayload({ comment: { id: 1, body: '/caf-review please', user: { login: 'ganjardbc', type: 'User' } } }), 'issue_comment');
      expect(response.statusCode).toBe(202);
      const [, jobData] = addJobMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(jobData.commentContext).toEqual([]);
    });

    it('includes a thread-starter inline comment in global mode even though the REST API sets in_reply_to_id to null', async () => {
      // GET /pulls/{number}/comments sets in_reply_to_id explicitly to `null`
      // for a thread-starter, not `undefined` — GithubService.listReviewComments()
      // must normalize this or thread-starters silently vanish from commentContext.
      listReviewCommentsMock.mockResolvedValueOnce([
        { id: 5001, body: 'fix this please', path: 'a.ts', line: 3, inReplyToId: undefined },
      ]);
      const response = await inject(issueCommentPayload({ comment: { id: 1, body: '/caf-fix-review', user: { login: 'ganjardbc', type: 'User' } } }), 'issue_comment');
      expect(response.statusCode).toBe(202);
      const [, jobData] = addJobMock.mock.calls[0] as [string, Record<string, unknown>];
      const commentContext = jobData.commentContext as Array<{ id: number; label: string }>;
      expect(commentContext).toContainEqual(expect.objectContaining({ id: 5001, label: 'INLINE' }));
    });

    it('fails closed silently (200, no enqueue) when the sender lacks permission', async () => {
      checkReviewPermissionMock.mockResolvedValueOnce(false);
      const response = await inject(issueCommentPayload(), 'issue_comment');
      expect(response.statusCode).toBe(200);
      expect(addJobMock).not.toHaveBeenCalled();
    });

    it('ignores a comment posted by a bot account even if it matches a slash command (anti-self-trigger)', async () => {
      const response = await inject(
        issueCommentPayload({ comment: { id: 1, body: '/caf-review', user: { login: 'caf-orchestrator-bot', type: 'Bot' } } }),
        'issue_comment',
      );
      expect(response.statusCode).toBe(200);
      expect(addJobMock).not.toHaveBeenCalled();
    });
  });

  describe('pull_request_review_comment', () => {
    it('ignores a thread-starter comment with no in_reply_to_id (falsy check, not strict null)', async () => {
      const response = await inject(
        prReviewCommentPayload({ comment: { id: 1, body: 'x', path: 'a.ts', line: 1, in_reply_to_id: null } }),
        'pull_request_review_comment',
      );
      expect(response.statusCode).toBe(200);
      expect(addJobMock).not.toHaveBeenCalled();
    });

    it('ignores a thread-starter comment with the field entirely absent', async () => {
      const response = await inject(
        prReviewCommentPayload({ comment: { id: 1, body: 'x', path: 'a.ts', line: 1 } }),
        'pull_request_review_comment',
      );
      expect(response.statusCode).toBe(200);
      expect(addJobMock).not.toHaveBeenCalled();
    });

    it('enqueues a scoped-mode pr-review job for a reply comment', async () => {
      const response = await inject(prReviewCommentPayload(), 'pull_request_review_comment');
      expect(response.statusCode).toBe(202);
      const [name, jobData] = addJobMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(name).toBe('pr-review');
      expect(jobData.mode).toBe('scoped');
      expect(jobData.prHeadBranch).toBe('ai-agent/CAF-PRREVIEW-01');
    });

    it('fails closed silently (200, no enqueue) when the sender lacks permission', async () => {
      checkReviewPermissionMock.mockResolvedValueOnce(false);
      const response = await inject(prReviewCommentPayload(), 'pull_request_review_comment');
      expect(response.statusCode).toBe(200);
      expect(addJobMock).not.toHaveBeenCalled();
    });
  });
});
