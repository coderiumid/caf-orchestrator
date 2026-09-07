import { describe, it, expect, vi } from 'vitest';

const configMock = {
  dashboard: { enabled: true, basicAuthUser: 'admin' },
  DASHBOARD_BASIC_AUTH_PASSWORD: 'correct-horse',
};

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
}));

describe('GET /dashboard', () => {
  it('rejects requests with no auth header (401)', async () => {
    const Fastify = (await import('fastify')).default;
    const { dashboardUiRoutes } = await import('../../src/presentation/web/routes/dashboard-ui.js');
    const app = Fastify();
    await app.register(dashboardUiRoutes);

    const response = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('serves the dashboard HTML page with correct credentials', async () => {
    const Fastify = (await import('fastify')).default;
    const { dashboardUiRoutes } = await import('../../src/presentation/web/routes/dashboard-ui.js');
    const app = Fastify();
    await app.register(dashboardUiRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { authorization: `Basic ${Buffer.from('admin:correct-horse').toString('base64')}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('CAF Orchestrator');
    expect(response.body).toContain('/api/events/stream');
    expect(response.body).toContain('/api/pipelines');

    await app.close();
  });
});
