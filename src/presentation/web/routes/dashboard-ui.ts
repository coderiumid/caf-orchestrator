import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
import { registerDashboardBasicAuth } from '../auth/dashboard-basic-auth.js';
import { renderDashboardHtml, renderDashboardCss, renderDashboardJs, renderDashboardLogo } from '../ui/dashboard-page.js';

/**
 * CAF-DASHBOARD-01 Task 6: serves the vanilla-JS SPA (see dashboard-page.ts) —
 * the HTML at /dashboard and its CSS/JS at /dashboard/app.css and
 * /dashboard/app.js, all behind the same basic-auth hook.
 */
export async function dashboardUiRoutes(app: FastifyInstance): Promise<void> {
  if (!config.dashboard.enabled) {
    return;
  }

  await registerDashboardBasicAuth(app);
  app.addHook('onRequest', app.basicAuth);

  app.get('/dashboard', async (_request, reply) => {
    reply.type('text/html').send(renderDashboardHtml());
  });

  app.get('/dashboard/app.css', async (_request, reply) => {
    reply.type('text/css').send(renderDashboardCss());
  });

  app.get('/dashboard/app.js', async (_request, reply) => {
    reply.type('application/javascript').send(renderDashboardJs());
  });

  app.get('/dashboard/logo.png', async (_request, reply) => {
    reply.type('image/png').send(renderDashboardLogo());
  });
}
