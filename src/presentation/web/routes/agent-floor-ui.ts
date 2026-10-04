import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
import { registerDashboardBasicAuth } from '../auth/dashboard-basic-auth.js';
import { dashboardAuthSetCookie } from '../auth/dashboard-auth-cookie.js';
import { renderAgentFloorHtml, agentFloorAssets } from '../ui/agent-floor-page.js';

/**
 * CAF-DASHBOARD-02: the Agent Floor — a separate, read-only page at
 * /dashboard/agent-floor (live), /dashboard/agent-floor?demo=1 (mock
 * scenarios, no data access). Same on/off switch and same Basic Auth as the
 * rest of the dashboard. Like GET /dashboard, the page handler sets the SSE
 * auth cookie, so opening this page directly (without visiting /dashboard
 * first) can still connect to /api/events/stream.
 */
export async function agentFloorUiRoutes(app: FastifyInstance): Promise<void> {
  if (!config.dashboard.enabled) {
    return;
  }

  await registerDashboardBasicAuth(app);
  app.addHook('onRequest', app.basicAuth);

  app.get('/dashboard/agent-floor', async (_request, reply) => {
    reply.header('Set-Cookie', dashboardAuthSetCookie()).type('text/html').send(renderAgentFloorHtml());
  });

  for (const [name, asset] of Object.entries(agentFloorAssets())) {
    app.get(`/dashboard/agent-floor/${name}`, async (_request, reply) => {
      reply.type(asset.contentType).send(asset.body);
    });
  }
}
