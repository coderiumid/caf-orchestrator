import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SECRET = 'test-webhook-secret';
const READY_STATE_ID = '3b76f298-054b-4de8-8ea6-071dcadefeb4';
const PREVIOUS_STATE_ID = '00000000-0000-0000-0000-000000000099';

const configMock = {
  LINEAR_WEBHOOK_SECRET: SECRET,
  ENABLE_PIPELINE_TRIGGER: true,
  linear: {
    webhookTimestampToleranceMs: 60_000,
    readyStateId: READY_STATE_ID,
  },
  repo: {
    cloneUrl: 'git@github.com:ganjardbc/umkm-pos.git',
    baseBranch: 'main',
  },
  dashboard: { enabled: false },
};

const umkmPosProject = {
  ticketPrefix: 'GAN',
  repoCloneUrl: 'git@github.com:ganjardbc/umkm-pos.git',
  baseBranch: 'main',
  workspaceDir: '/tmp/caf-orchestrator/workspace/umkm-pos',
  agents: { modelOverrides: {} },
};

const projectRegistryMock = {
  getByPrefix: vi.fn((prefix: string) => (prefix === 'GAN' ? umkmPosProject : undefined)),
};

const addJobMock = vi.fn().mockResolvedValue('job-1');
const claimDeliveryMock = vi.fn().mockResolvedValue(true);

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
  get projectRegistry() {
    return projectRegistryMock;
  },
}));

vi.mock('../../src/infrastructure/queue/client.js', () => ({
  pipelineQueue: { addJob: addJobMock, close: vi.fn() },
  rawPipelineQueue: {},
}));

vi.mock('../../src/infrastructure/linear/delivery-dedupe.js', () => ({
  claimDelivery: claimDeliveryMock,
}));

function signBody(rawBody: string, secret: string = SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function buildPayload(identifier: string, overrides: Record<string, unknown> = {}) {
  return {
    action: 'update',
    type: 'Issue',
    data: {
      id: '00000000-0000-0000-0000-000000000001',
      identifier,
      stateId: READY_STATE_ID,
      title: 'Example ticket',
      description: 'Example description',
    },
    updatedFrom: { stateId: PREVIOUS_STATE_ID },
    webhookTimestamp: Date.now(),
    ...overrides,
  };
}

async function inject(body: unknown, headers: Record<string, string> = {}) {
  const { buildApp } = await import('../../src/presentation/web/app.js');
  const app = buildApp();
  const rawBody = JSON.stringify(body);
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/linear',
    payload: rawBody,
    headers: {
      'content-type': 'application/json',
      'linear-signature': signBody(rawBody),
      'linear-timestamp': String(Date.now()),
      'linear-delivery': `delivery-${Math.random()}`,
      ...headers,
    },
  });
  await app.close();
  return response;
}

describe('webhook ticket-prefix routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addJobMock.mockResolvedValue('job-1');
    claimDeliveryMock.mockResolvedValue(true);
    projectRegistryMock.getByPrefix.mockImplementation((prefix: string) =>
      prefix === 'GAN' ? umkmPosProject : undefined,
    );
  });

  it('routes a registered prefix (GAN-99) to the matching project and enqueues the job', async () => {
    const response = await inject(buildPayload('GAN-99'));

    expect(response.statusCode).toBe(202);
    expect(addJobMock).toHaveBeenCalledTimes(1);
    const [, jobData] = addJobMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(jobData.ticketKey).toBe('GAN-99');
    expect(jobData.projectConfig).toEqual({
      repoCloneUrl: umkmPosProject.repoCloneUrl,
      baseBranch: umkmPosProject.baseBranch,
      workspaceDir: umkmPosProject.workspaceDir,
      agents: umkmPosProject.agents,
    });
  });

  it('fails closed for a well-formed but unregistered prefix (XYZ-1): 200, no enqueue', async () => {
    const response = await inject(buildPayload('XYZ-1'));

    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it.each(['12345', 'gan-1', 'GAN', 'GAN-43-extra'])(
    'fails closed for a malformed identifier %j without crashing',
    async (identifier) => {
      const response = await inject(buildPayload(identifier));
      expect(response.statusCode).toBe(200);
      expect(addJobMock).not.toHaveBeenCalled();
    },
  );

  it('fails closed for an empty identifier (rejected earlier by DTO schema validation, still 200)', async () => {
    const response = await inject(buildPayload(''));
    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('regression: rejects a request with an invalid signature before touching routing logic', async () => {
    const response = await inject(buildPayload('GAN-99'), { 'linear-signature': 'deadbeef' });

    expect(response.statusCode).toBe(401);
    expect(addJobMock).not.toHaveBeenCalled();
    expect(projectRegistryMock.getByPrefix).not.toHaveBeenCalled();
  });

  it('regression: duplicate delivery is still ignored before reaching routing logic', async () => {
    claimDeliveryMock.mockResolvedValueOnce(false);

    const response = await inject(buildPayload('GAN-99'));

    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
    expect(projectRegistryMock.getByPrefix).not.toHaveBeenCalled();
  });

  it('regression: a non-transition update (no stateId in updatedFrom) is still ignored before routing', async () => {
    const response = await inject(buildPayload('GAN-99', { updatedFrom: { title: 'old title' } }));

    expect(response.statusCode).toBe(200);
    expect(addJobMock).not.toHaveBeenCalled();
    expect(projectRegistryMock.getByPrefix).not.toHaveBeenCalled();
  });
});
