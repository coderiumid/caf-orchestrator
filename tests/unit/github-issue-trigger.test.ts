import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SECRET = 'test-github-webhook-secret';

const PROJECT = {
  ticketPrefix: 'CDR',
  repoCloneUrl: 'https://github.com/ganjardbc/coderium-web-v2.git',
  baseBranch: 'main',
  workspaceDir: '/tmp/caf-orchestrator/workspace/coderium-web-v2',
  agents: { modelOverrides: {} },
};

const configMock = {
  GITHUB_WEBHOOK_SECRET: SECRET,
  ENABLE_PIPELINE_TRIGGER: true,
  github: {
    apiUrl: 'https://api.github.com',
    deliveryDedupeTtlSeconds: 86_400,
    readyLabel: 'ready-for-ai',
  },
  dashboard: { enabled: false },
};

const addJobMock = vi.fn().mockResolvedValue('job-1');
const claimDeliveryMock = vi.fn().mockResolvedValue(true);
const checkReviewPermissionMock = vi.fn().mockResolvedValue(true);
const getAllMock = vi.fn().mockReturnValue([PROJECT]);

// Mirrors the real regex in src/infrastructure/vcs/github.service.ts —
// duplicated here (not imported) because this whole module is mocked out
// below to keep the test isolated from real HTTP calls.
function parseGithubRepo(cloneUrl: string): { owner: string; repo: string } {
  const match = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(cloneUrl);
  if (!match) throw new Error(`Could not parse owner/repo from clone URL: ${cloneUrl}`);
  const [, owner, repo] = match;
  return { owner, repo };
}

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
  projectRegistry: { getAll: getAllMock },
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
  githubService: {},
  parseGithubRepo,
}));

function signBody(rawBody: string, secret: string = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function inject(body: unknown, headers: Record<string, string> = {}) {
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
      'x-github-event': 'issues',
      ...headers,
    },
  });
  await app.close();
  return response;
}

function issuesLabeledPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    label: { name: 'ready-for-ai' },
    issue: { number: 25, title: 'Add dark mode toggle', body: 'Some description' },
    repository: { full_name: 'ganjardbc/coderium-web-v2' },
    sender: { login: 'ganjardbc' },
    ...overrides,
  };
}

describe('github issues webhook trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addJobMock.mockResolvedValue('job-1');
    claimDeliveryMock.mockResolvedValue(true);
    checkReviewPermissionMock.mockResolvedValue(true);
    getAllMock.mockReturnValue([PROJECT]);
  });

  it('enqueues an agent-pipeline job with ticketSource github on a matching labeled event', async () => {
    const response = await inject(issuesLabeledPayload());
    expect(response.statusCode).toBe(202);
    expect(addJobMock).toHaveBeenCalledTimes(1);
    const [name, jobData] = addJobMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('agent-pipeline');
    expect(jobData.ticketKey).toBe('CDR-25');
    expect(jobData.ticketId).toBe('25');
    expect(jobData.ticketTitle).toBe('Add dark mode toggle');
    expect(jobData.ticketSource).toBe('github');
    expect((jobData.projectConfig as { repoCloneUrl: string }).repoCloneUrl).toBe(PROJECT.repoCloneUrl);
  });

  it('ignores a non-labeled action', async () => {
    const response = await inject(issuesLabeledPayload({ action: 'opened' }));
    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('ignores a label that does not match github.readyLabel', async () => {
    const response = await inject(issuesLabeledPayload({ label: { name: 'bug' } }));
    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('ignores when the sender lacks permission', async () => {
    checkReviewPermissionMock.mockResolvedValueOnce(false);
    const response = await inject(issuesLabeledPayload());
    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('ignores when no project matches the repo', async () => {
    getAllMock.mockReturnValue([]);
    const response = await inject(issuesLabeledPayload());
    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('reports disabled when ENABLE_PIPELINE_TRIGGER is false', async () => {
    configMock.ENABLE_PIPELINE_TRIGGER = false;
    const response = await inject(issuesLabeledPayload());
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { status: string };
    expect(body.status).toBe('disabled');
    expect(addJobMock).not.toHaveBeenCalled();
    configMock.ENABLE_PIPELINE_TRIGGER = true;
  });
});
