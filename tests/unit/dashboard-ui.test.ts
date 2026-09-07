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
  // reply.cspNonce is set by @fastify/helmet's enableCSPNonces (see app.ts) —
  // dashboard-ui.ts relies on it being present, so register the same plugin
  // with the same option here rather than a bare Fastify instance.
  async function buildTestApp() {
    const Fastify = (await import('fastify')).default;
    const helmet = (await import('@fastify/helmet')).default;
    const { dashboardUiRoutes } = await import('../../src/presentation/web/routes/dashboard-ui.js');
    const app = Fastify();
    await app.register(helmet, { enableCSPNonces: true });
    await app.register(dashboardUiRoutes);
    return app;
  }

  it('rejects requests with no auth header (401)', async () => {
    const app = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('serves the dashboard HTML page with correct credentials, with matching CSP nonces', async () => {
    const app = await buildTestApp();

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

    // The nonce baked into the inline <script>/<style> tags must match the
    // one the CSP response header actually allows — otherwise the browser
    // blocks it exactly like the bug this fix addresses.
    const csp = response.headers['content-security-policy'] as string;
    const scriptNonceMatch = /<script nonce="([0-9a-f]+)">/.exec(response.body);
    const styleNonceMatch = /<style nonce="([0-9a-f]+)">/.exec(response.body);
    expect(scriptNonceMatch).not.toBeNull();
    expect(styleNonceMatch).not.toBeNull();
    expect(csp).toContain(`'nonce-${scriptNonceMatch![1]}'`);
    expect(csp).toContain(`'nonce-${styleNonceMatch![1]}'`);

    await app.close();
  });
});
