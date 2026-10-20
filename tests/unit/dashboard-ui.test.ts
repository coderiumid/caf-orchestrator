import { describe, it, expect, vi } from 'vitest';
import { sessionCookie } from '../helpers/dashboard-session.js';

const configMock = {
  dashboard: { enabled: true, basicAuthUser: 'admin' },
  DASHBOARD_BASIC_AUTH_PASSWORD: 'correct-horse',
  DASHBOARD_DEFAULT_VIEW: 'dashboard' as 'dashboard' | 'agent-floor',
};

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
}));

describe('dashboard UI routes', () => {
  async function buildTestApp() {
    const Fastify = (await import('fastify')).default;
    const { dashboardUiRoutes } = await import('../../src/presentation/web/routes/dashboard-ui.js');
    const app = Fastify();
    await app.register(dashboardUiRoutes);
    return app;
  }

  const session = { cookie: sessionCookie('admin', 'correct-horse') };

  it('redirects every private page and asset to the login page without a session', async () => {
    const app = await buildTestApp();

    for (const url of ['/dashboard', '/dashboard/app.css', '/dashboard/app.js', '/dashboard/session.js', '/dashboard/floor/render.js']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(302);
      expect(response.headers.location, url).toBe('/dashboard/login');
    }
    await app.close();
  });

  it('serves the login page and its assets without a session', async () => {
    const app = await buildTestApp();

    const page = await app.inject({ method: 'GET', url: '/dashboard/login' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('CAF Login');
    expect(page.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);

    for (const [url, type] of [
      ['/dashboard/login.css', 'text/css'],
      ['/dashboard/login.js', 'javascript'],
      ['/dashboard/ds.css', 'text/css'],
      ['/dashboard/logo.png', 'image/png'],
    ] as const) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toContain(type);
    }
    await app.close();
  });

  it('sets an HttpOnly session cookie on a correct login, and none on a wrong one', async () => {
    const app = await buildTestApp();

    const ok = await app.inject({ method: 'POST', url: '/dashboard/login', payload: { username: 'admin', password: 'correct-horse' } });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(/^caf_dashboard_session=\d+\.[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);

    // the issued cookie really opens the dashboard
    const page = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: cookie.split(';')[0] } });
    expect(page.statusCode).toBe(200);

    for (const payload of [
      { username: 'admin', password: 'nope' },
      { username: 'root', password: 'correct-horse' },
      { username: 'admin' },
      {},
    ]) {
      const bad = await app.inject({ method: 'POST', url: '/dashboard/login', payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(401);
      expect(bad.headers['set-cookie']).toBeUndefined();
    }
    await app.close();
  });

  it('rejects an expired, forged or foreign-password session', async () => {
    const app = await buildTestApp();

    for (const cookie of [
      sessionCookie('admin', 'correct-horse', Date.now() - 1000),
      sessionCookie('admin', 'other-password'),
      'caf_dashboard_session=garbage',
    ]) {
      const response = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } });
      expect(response.statusCode, cookie).toBe(302);
    }
    await app.close();
  });

  it('logs out by clearing the cookie, and bounces a logged-in visitor off the login page', async () => {
    const app = await buildTestApp();

    const out = await app.inject({ method: 'POST', url: '/dashboard/logout' });
    expect(String(out.headers['set-cookie'])).toContain('caf_dashboard_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');

    const login = await app.inject({ method: 'GET', url: '/dashboard/login', headers: session });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe('/dashboard');
    await app.close();
  });

  it('serves the monitoring dashboard at /dashboard when DASHBOARD_DEFAULT_VIEW=dashboard', async () => {
    const app = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/dashboard', headers: session });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('CAF Dashboard');
    expect(response.body).toContain('/dashboard/ds.css');
    expect(response.body).toContain('/dashboard/app.css');
    expect(response.body).toContain('/dashboard/app.js');
    expect(response.body).toContain('js-logout');
    await app.close();
  });

  it('serves the Agent Floor at the same /dashboard route when DASHBOARD_DEFAULT_VIEW=agent-floor', async () => {
    configMock.DASHBOARD_DEFAULT_VIEW = 'agent-floor';
    try {
      const app = await buildTestApp();
      const response = await app.inject({ method: 'GET', url: '/dashboard', headers: session });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('CAF Agent Floor');
      expect(response.body).toContain('js-logout');

      // ?demo=1 is decided in the browser: same page
      const demo = await app.inject({ method: 'GET', url: '/dashboard?demo=1', headers: session });
      expect(demo.body).toBe(response.body);

      // the old route is gone
      expect((await app.inject({ method: 'GET', url: '/dashboard/agent-floor', headers: session })).statusCode).toBe(404);
      await app.close();
    } finally {
      configMock.DASHBOARD_DEFAULT_VIEW = 'dashboard';
    }
  });

  it('serves the dashboard stylesheet, script and shared design system', async () => {
    const app = await buildTestApp();

    const css = await app.inject({ method: 'GET', url: '/dashboard/app.css', headers: session });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.body).toContain('.run-grid');

    const ds = await app.inject({ method: 'GET', url: '/dashboard/ds.css' });
    expect(ds.statusCode).toBe(200);
    expect(ds.body).toContain('--accent');

    const js = await app.inject({ method: 'GET', url: '/dashboard/app.js', headers: session });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.body).toContain('/api/events/stream');
    expect(js.body).toContain('/api/pipelines');

    const logout = await app.inject({ method: 'GET', url: '/dashboard/session.js', headers: session });
    expect(logout.statusCode).toBe(200);
    expect(logout.body).toContain('/dashboard/logout');
    await app.close();
  });

  it('is not registered at all when the dashboard is disabled', async () => {
    configMock.dashboard.enabled = false;
    try {
      const app = await buildTestApp();
      expect((await app.inject({ method: 'GET', url: '/dashboard/login' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/dashboard', headers: session })).statusCode).toBe(404);
      await app.close();
    } finally {
      configMock.dashboard.enabled = true;
    }
  });
});
