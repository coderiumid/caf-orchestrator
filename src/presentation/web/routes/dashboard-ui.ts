import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
import { registerDashboardBasicAuth } from '../auth/dashboard-basic-auth.js';
import { DASHBOARD_HTML } from '../ui/dashboard-page.js';

/**
 * CAF-DASHBOARD-01 Task 6: GET /dashboard serves the vanilla-JS SPA (see
 * dashboard-page.ts). Named dashboard-ui.ts (not dashboard.ts) to avoid
 * clashing with the existing Bull Board route file — different route
 * (`/dashboard` vs. `/admin/queues`), same auth reuse pattern.
 */
export async function dashboardUiRoutes(app: FastifyInstance): Promise<void> {
  if (!config.dashboard.enabled) {
    return;
  }

  await registerDashboardBasicAuth(app);
  app.addHook('onRequest', app.basicAuth);

  app.get('/dashboard', async (_request, reply) => {
    reply.type('text/html').send(DASHBOARD_HTML);
  });
}
