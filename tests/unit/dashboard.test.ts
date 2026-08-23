import { describe, it, expect, vi, beforeEach } from 'vitest';

const configMock = {
  dashboard: { enabled: true, basicAuthUser: 'admin' },
  DASHBOARD_BASIC_AUTH_PASSWORD: 'correct-horse',
};

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
}));

vi.mock('../../src/infrastructure/queue/client.js', () => ({
  rawPipelineQueue: {
    name: 'agent-pipeline',
    metaValues: { version: 'bullmq:5.0.0' },
    client: Promise.resolve({}),
    getJobCounts: vi.fn().mockResolvedValue({}),
  },
  pipelineQueue: { addJob: vi.fn(), close: vi.fn() },
}));

describe('dashboard basic auth', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects requests with no auth header (401)', async () => {
    const { buildApp } = await import('../../src/presentation/web/app.js');
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/admin/queues/' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects requests with wrong credentials (401)', async () => {
    const { buildApp } = await import('../../src/presentation/web/app.js');
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/admin/queues/',
      headers: {
        authorization: `Basic ${Buffer.from('admin:wrong-password').toString('base64')}`,
      },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('accepts requests with correct credentials (200)', async () => {
    const { buildApp } = await import('../../src/presentation/web/app.js');
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/admin/queues/',
      headers: {
        authorization: `Basic ${Buffer.from('admin:correct-horse').toString('base64')}`,
      },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
