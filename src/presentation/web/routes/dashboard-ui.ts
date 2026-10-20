import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
import {
  credentialsValid,
  hasValidSession,
  requireSessionOrRedirect,
  sessionClearCookie,
  sessionSetCookie,
  DASHBOARD_LOGIN_PATH,
} from '../auth/dashboard-session.js';
import { renderDashboardHtml, renderDashboardCss, renderDashboardJs, renderDashboardLogo, renderDesignSystemCss } from '../ui/dashboard-page.js';
import { renderAgentFloorHtml, agentFloorAssets } from '../ui/agent-floor-page.js';
import { loginHtml, loginCss, loginJs, sessionJs } from '../ui/login-page.js';

/**
 * The dashboard's pages. `GET /dashboard` serves one of two UIs, picked by
 * `DASHBOARD_DEFAULT_VIEW` (`dashboard` = pipeline monitoring SPA,
 * `agent-floor` = the Agent Floor); there is no separate route per view.
 * The Agent Floor's own files live under `/dashboard/floor/*`, the monitoring
 * SPA's under `/dashboard/app.css|app.js`; `?demo=1` is decided in the
 * browser by the Agent Floor script.
 *
 * Auth is a login page + signed session cookie (auth/dashboard-session.ts),
 * not browser Basic Auth. Public: the login page, POST login/logout, and the
 * design system / logo / login assets that page needs. Everything else here
 * redirects to the login page without a session.
 */
export async function dashboardUiRoutes(app: FastifyInstance): Promise<void> {
  if (!config.dashboard.enabled) {
    return;
  }

  app.get(DASHBOARD_LOGIN_PATH, async (request, reply) => {
    if (hasValidSession(request)) {
      return reply.redirect('/dashboard');
    }
    return reply.header('Cache-Control', 'no-store').type('text/html').send(loginHtml);
  });

  app.post(DASHBOARD_LOGIN_PATH, async (request, reply) => {
    const body = (request.body ?? {}) as { username?: unknown; password?: unknown };
    if (!credentialsValid(body.username, body.password)) {
      return reply.code(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid credentials' });
    }
    return reply.header('Set-Cookie', sessionSetCookie(request)).send({ ok: true });
  });

  app.post('/dashboard/logout', async (request, reply) => {
    return reply.header('Set-Cookie', sessionClearCookie(request)).send({ ok: true });
  });

  app.get('/dashboard/login.css', async (_request, reply) => {
    reply.type('text/css').send(loginCss);
  });

  app.get('/dashboard/login.js', async (_request, reply) => {
    reply.type('application/javascript').send(loginJs);
  });

  // Shared by every page under /dashboard, the login page included.
  app.get('/dashboard/ds.css', async (_request, reply) => {
    reply.type('text/css').send(renderDesignSystemCss());
  });

  app.get('/dashboard/logo.png', async (_request, reply) => {
    reply.type('image/png').send(renderDashboardLogo());
  });

  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', requireSessionOrRedirect);

    protectedScope.get('/dashboard', async (_request, reply) => {
      const html = config.DASHBOARD_DEFAULT_VIEW === 'agent-floor' ? renderAgentFloorHtml() : renderDashboardHtml();
      reply.header('Cache-Control', 'no-store').type('text/html').send(html);
    });

    protectedScope.get('/dashboard/session.js', async (_request, reply) => {
      reply.type('application/javascript').send(sessionJs);
    });

    protectedScope.get('/dashboard/app.css', async (_request, reply) => {
      reply.type('text/css').send(renderDashboardCss());
    });

    protectedScope.get('/dashboard/app.js', async (_request, reply) => {
      reply.type('application/javascript').send(renderDashboardJs());
    });

    for (const [name, asset] of Object.entries(agentFloorAssets())) {
      protectedScope.get(`/dashboard/floor/${name}`, async (_request, reply) => {
        reply.type(asset.contentType).send(asset.body);
      });
    }
  });
}
