import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// CAF-SDD-04c: the Linear trigger carries the issue's labels and the resolved
// gate label (AC-1, AC-9), on both a new-ticket job and a resume.

const SECRET = 'test-webhook-secret';
const READY_STATE_ID = '3b76f298-054b-4de8-8ea6-071dcadefeb4';

const configMock = {
  LINEAR_WEBHOOK_SECRET: SECRET,
  ENABLE_PIPELINE_TRIGGER: true,
  linear: { webhookTimestampToleranceMs: 60_000, readyStateId: READY_STATE_ID, specGateLabel: 'spec-approval' },
  orchestration: { maxOrchestrationRetries: 2 },
  dashboard: { enabled: false },
};
const project = {
  ticketPrefix: 'GAN',
  repoCloneUrl: 'git@github.com:ganjardbc/umkm-pos.git',
  baseBranch: 'main',
  workspaceDir: '/tmp/caf-orchestrator/workspace/umkm-pos',
  agents: { modelOverrides: {} },
  orchestration: {},
};
const projectRegistryMock = { getByPrefix: vi.fn((prefix: string) => (prefix === 'GAN' ? project : undefined)) };
const addJobMock = vi.fn().mockResolvedValue('job-1');
const branchExistsMock = vi.fn().mockResolvedValue(false);

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
  get projectRegistry() {
    return projectRegistryMock;
  },
}));
vi.mock('../../src/infrastructure/queue/client.js', () => ({ pipelineQueue: { addJob: addJobMock, close: vi.fn() } }));
vi.mock('../../src/infrastructure/linear/delivery-dedupe.js', () => ({ claimDelivery: vi.fn().mockResolvedValue(true) }));
vi.mock('../../src/infrastructure/vcs/github.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/infrastructure/vcs/github.service.js')>();
  return { ...actual, githubService: { branchExists: branchExistsMock, findOpenPullRequestByHead: vi.fn().mockResolvedValue(undefined) } };
});

function payload(dataOverrides: Record<string, unknown> = {}) {
  return {
    action: 'update',
    type: 'Issue',
    data: { id: 'uuid-1', identifier: 'GAN-7', stateId: READY_STATE_ID, title: 'T', description: 'D', ...dataOverrides },
    updatedFrom: { stateId: '00000000-0000-0000-0000-000000000099' },
    webhookTimestamp: Date.now(),
  };
}

async function inject(body: unknown) {
  const { buildApp } = await import('../../src/presentation/web/app.js');
  const app = buildApp();
  const raw = JSON.stringify(body);
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/linear',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'linear-signature': createHmac('sha256', SECRET).update(raw).digest('hex'),
      'linear-timestamp': String(Date.now()),
      'linear-delivery': `delivery-${Math.random()}`,
    },
  });
  await app.close();
  return response;
}

describe('Linear webhook — labels for the spec gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    branchExistsMock.mockResolvedValue(false);
  });

  it('passes the label names and the gate label on a new-ticket job', async () => {
    await inject(payload({ labels: [{ id: 'l1', name: 'spec-approval' }, { id: 'l2', name: 'bug' }] }));

    expect(addJobMock.mock.calls[0][1]).toMatchObject({ ticketLabels: ['spec-approval', 'bug'], specGateLabel: 'spec-approval' });
  });

  it('a payload without labels yields an empty list', async () => {
    await inject(payload());

    expect(addJobMock.mock.calls[0][1]).toMatchObject({ ticketLabels: [], specGateLabel: 'spec-approval' });
  });

  it('AC-1: a per-project Linear gate label wins', async () => {
    projectRegistryMock.getByPrefix.mockReturnValueOnce({ ...project, linear: { specGateLabel: 'ln-gate' } });

    await inject(payload({ labels: [{ name: 'ln-gate' }] }));

    expect(addJobMock.mock.calls[0][1]).toMatchObject({ ticketLabels: ['ln-gate'], specGateLabel: 'ln-gate' });
  });

  it('the resume job (branch already exists) carries them too', async () => {
    branchExistsMock.mockResolvedValue(true);

    await inject(payload({ labels: [{ name: 'spec-approval' }] }));

    expect(addJobMock.mock.calls[0][1]).toMatchObject({ isRetry: true, ticketLabels: ['spec-approval'], specGateLabel: 'spec-approval' });
  });
});
