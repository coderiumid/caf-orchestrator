import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// CAF-SDD-04c: /caf-approve-spec (AC-12, AC-13, AC-17) and the GitHub Issue
// trigger carrying labels / resuming an existing branch (AC-6, AC-9).

const SECRET = 'test-github-webhook-secret';

const PROJECT = {
  ticketPrefix: 'CDR',
  repoCloneUrl: 'https://github.com/ganjardbc/coderium-web-v2.git',
  baseBranch: 'main',
  workspaceDir: '/tmp/caf-orchestrator/workspace/coderium-web-v2',
  agents: { modelOverrides: {} },
  orchestration: {},
};

const configMock = {
  GITHUB_WEBHOOK_SECRET: SECRET,
  ENABLE_PIPELINE_TRIGGER: true,
  github: { apiUrl: 'https://api.github.com', deliveryDedupeTtlSeconds: 86_400, readyLabel: 'ready-for-ai', specGateLabel: 'spec-approval' },
  orchestration: { maxOrchestrationRetries: 2 },
  dashboard: { enabled: false },
};

const addJobMock = vi.fn().mockResolvedValue('job-1');
const claimDeliveryMock = vi.fn().mockResolvedValue(true);
const checkReviewPermissionMock = vi.fn().mockResolvedValue(true);
const getPullRequestHeadRefMock = vi.fn().mockResolvedValue('ai-agent/CDR-25');
const postIssueCommentMock = vi.fn().mockResolvedValue(undefined);
const branchExistsMock = vi.fn().mockResolvedValue(false);
const findOpenPullRequestByHeadMock = vi.fn().mockResolvedValue(undefined);
const getByPrefixMock = vi.fn();
const getAllMock = vi.fn();

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
  projectRegistry: { getByPrefix: getByPrefixMock, getAll: getAllMock },
}));
vi.mock('../../src/infrastructure/queue/client.js', () => ({ pipelineQueue: { addJob: addJobMock, close: vi.fn() } }));
vi.mock('../../src/infrastructure/linear/delivery-dedupe.js', () => ({ claimDelivery: claimDeliveryMock }));
vi.mock('../../src/infrastructure/vcs/github-permission.js', () => ({ checkReviewPermission: checkReviewPermissionMock }));
vi.mock('../../src/infrastructure/vcs/github.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/infrastructure/vcs/github.service.js')>();
  return {
    ...actual,
    githubService: {
      getPullRequestHeadRef: getPullRequestHeadRefMock,
      postIssueComment: postIssueCommentMock,
      branchExists: branchExistsMock,
      findOpenPullRequestByHead: findOpenPullRequestByHeadMock,
    },
  };
});

const sign = (raw: string) => 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');

async function inject(body: unknown, eventType: string, headers: Record<string, string> = {}) {
  const { buildApp } = await import('../../src/presentation/web/app.js');
  const app = buildApp();
  const raw = JSON.stringify(body);
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/github',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(raw),
      'x-github-delivery': `delivery-${Math.random()}`,
      'x-github-event': eventType,
      ...headers,
    },
  });
  await app.close();
  return response;
}

const approvePayload = (overrides: Record<string, unknown> = {}) => ({
  action: 'created',
  comment: { id: 2001, body: '/caf-approve-spec', user: { login: 'ganjardbc', type: 'User' } },
  issue: { number: 9, pull_request: { url: 'https://api.github.com/.../pulls/9' } },
  repository: { full_name: 'ganjardbc/coderium-web-v2' },
  sender: { login: 'ganjardbc' },
  ...overrides,
});

const labeledPayload = (issueOverrides: Record<string, unknown> = {}) => ({
  action: 'labeled',
  label: { name: 'ready-for-ai' },
  issue: { number: 25, title: 'Add dark mode', body: 'desc', labels: [{ name: 'ready-for-ai' }, { name: 'spec-approval' }], ...issueOverrides },
  repository: { full_name: 'ganjardbc/coderium-web-v2' },
  sender: { login: 'ganjardbc' },
});

describe('/caf-approve-spec webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.ENABLE_PIPELINE_TRIGGER = true;
    addJobMock.mockResolvedValue('job-1');
    claimDeliveryMock.mockResolvedValue(true);
    checkReviewPermissionMock.mockResolvedValue(true);
    getPullRequestHeadRefMock.mockResolvedValue('ai-agent/CDR-25');
    getByPrefixMock.mockReturnValue(PROJECT);
    getAllMock.mockReturnValue([PROJECT]);
    branchExistsMock.mockResolvedValue(false);
    findOpenPullRequestByHeadMock.mockResolvedValue(undefined);
  });

  it('enqueues an approveSpec job carrying the PR as retryContext', async () => {
    const response = await inject(approvePayload(), 'issue_comment');

    expect(response.statusCode).toBe(202);
    const [name, job] = addJobMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('agent-pipeline');
    expect(job).toMatchObject({
      ticketKey: 'CDR-25',
      approveSpec: true,
      retryContext: { owner: 'ganjardbc', repo: 'coderium-web-v2', prNumber: 9 },
    });
    expect(job.isRetry).toBeUndefined();
  });

  it('AC-12: a bot account is ignored with 200 and nothing happens', async () => {
    const response = await inject(
      approvePayload({ comment: { id: 2002, body: '/caf-approve-spec', user: { login: 'github-actions[bot]', type: 'Bot' } } }),
      'issue_comment',
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ignored' });
    expect(addJobMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  it('AC-12: a sender without write permission is ignored with 200', async () => {
    checkReviewPermissionMock.mockResolvedValue(false);

    const response = await inject(approvePayload(), 'issue_comment');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ignored' });
    expect(addJobMock).not.toHaveBeenCalled();
    expect(getPullRequestHeadRefMock).not.toHaveBeenCalled();
  });

  it('AC-13: a PR whose branch is not ai-agent/* gets an explanation and no job', async () => {
    getPullRequestHeadRefMock.mockResolvedValue('feature/other');

    const response = await inject(approvePayload(), 'issue_comment');

    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
    expect(postIssueCommentMock).toHaveBeenCalledWith(expect.objectContaining({ owner: 'ganjardbc', repo: 'coderium-web-v2', issueNumber: 9 }));
    expect(postIssueCommentMock.mock.calls[0][0].body).toContain('ai-agent');
  });

  it('AC-13: an unregistered ticket prefix is ignored', async () => {
    getByPrefixMock.mockReturnValue(undefined);

    const response = await inject(approvePayload(), 'issue_comment');

    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('AC-17: goes through the same dedupe as the other commands', async () => {
    claimDeliveryMock.mockResolvedValueOnce(false);

    const response = await inject(approvePayload(), 'issue_comment');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reason: 'Duplicate delivery' });
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('AC-17: the kill switch disables it after the permission check', async () => {
    configMock.ENABLE_PIPELINE_TRIGGER = false;

    const response = await inject(approvePayload(), 'issue_comment');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'disabled' });
    expect(checkReviewPermissionMock).toHaveBeenCalled();
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('AC-17: a signature failure never reaches the handler', async () => {
    const response = await inject(approvePayload(), 'issue_comment', { 'x-hub-signature-256': 'sha256=deadbeef' });

    expect(response.statusCode).toBe(401);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('a comment on a plain issue is not an approval', async () => {
    const response = await inject(approvePayload({ issue: { number: 9 } }), 'issue_comment');

    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('leaves the existing /caf-retry-pipeline command alone', async () => {
    const response = await inject(
      approvePayload({ comment: { id: 3, body: '/caf-retry-pipeline', user: { login: 'ganjardbc', type: 'User' } } }),
      'issue_comment',
    );

    expect(response.statusCode).toBe(202);
    expect(addJobMock.mock.calls[0][1]).toMatchObject({ isRetry: true });
    expect(addJobMock.mock.calls[0][1]).not.toHaveProperty('approveSpec');
  });
});

describe('GitHub Issue trigger (labels, existing branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.ENABLE_PIPELINE_TRIGGER = true;
    claimDeliveryMock.mockResolvedValue(true);
    checkReviewPermissionMock.mockResolvedValue(true);
    getAllMock.mockReturnValue([PROJECT]);
    branchExistsMock.mockResolvedValue(false);
    findOpenPullRequestByHeadMock.mockResolvedValue(undefined);
  });

  it('carries the issue labels and the resolved gate label on a new-ticket job', async () => {
    const response = await inject(labeledPayload(), 'issues');

    expect(response.statusCode).toBe(202);
    const job = addJobMock.mock.calls[0][1] as Record<string, unknown>;
    expect(job).toMatchObject({ ticketKey: 'CDR-25', ticketSource: 'github', ticketLabels: ['ready-for-ai', 'spec-approval'], specGateLabel: 'spec-approval' });
    expect(job.isRetry).toBeUndefined();
  });

  it('AC-1: a per-project gate label overrides the global one', async () => {
    getAllMock.mockReturnValue([{ ...PROJECT, github: { specGateLabel: 'gh-gate' } }]);

    await inject(labeledPayload(), 'issues');

    expect(addJobMock.mock.calls[0][1]).toMatchObject({ specGateLabel: 'gh-gate' });
  });

  it('AC-6: a ticket whose branch already exists resumes on it (isRetry) instead of starting over', async () => {
    branchExistsMock.mockResolvedValue(true);

    const response = await inject(labeledPayload(), 'issues');

    expect(response.statusCode).toBe(202);
    expect(branchExistsMock).toHaveBeenCalledWith('ganjardbc', 'coderium-web-v2', 'ai-agent/CDR-25');
    expect(addJobMock.mock.calls[0][1]).toMatchObject({
      ticketKey: 'CDR-25',
      ticketSource: 'github',
      isRetry: true,
      maxOrchestrationRetries: 2,
      ticketLabels: ['ready-for-ai', 'spec-approval'],
    });
  });

  it('a resume with an open PR carries it as retryContext', async () => {
    branchExistsMock.mockResolvedValue(true);
    findOpenPullRequestByHeadMock.mockResolvedValue({ url: 'https://github.com/ganjardbc/coderium-web-v2/pull/9', number: 9 });

    await inject(labeledPayload(), 'issues');

    expect(addJobMock.mock.calls[0][1]).toMatchObject({ retryContext: { owner: 'ganjardbc', repo: 'coderium-web-v2', prNumber: 9 } });
  });
});
