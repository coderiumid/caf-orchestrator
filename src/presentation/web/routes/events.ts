import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
import { registerDashboardBasicAuth } from '../auth/dashboard-basic-auth.js';
import { eventBroadcaster } from '../sse/event-broadcaster.js';

/**
 * CAF-DASHBOARD-01 Task 4: SSE push endpoint. Gated + auth-protected here in
 * Task 5, which is when this dashboard's auth story (reuse Bull Board's
 * basic-auth) actually lands across the whole surface — Task 4 deliberately
 * left this route open, see verify-report.md.
 */
export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  if (!config.dashboard.enabled) {
    return;
  }

  await registerDashboardBasicAuth(app);
  app.addHook('onRequest', app.basicAuth);

  app.get('/api/events/stream', (request, reply) => {
    // Fastify would otherwise try to manage/send its own reply — hijack()
    // hands full control of the underlying response to us for the life of
    // this connection.
    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write(':connected\n\n');

    const unsubscribe = eventBroadcaster.subscribe({
      write: (chunk: string) => reply.raw.write(chunk),
    });

    request.raw.on('close', unsubscribe);
  });
}
