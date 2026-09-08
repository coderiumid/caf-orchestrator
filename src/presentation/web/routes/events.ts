import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
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

  // EventSource cannot set an Authorization header. The dashboard handler
  // sets this same-origin cookie after Basic Auth succeeds; the browser sends
  // it automatically with the long-lived SSE request.
  app.addHook('onRequest', async (request, reply) => {
    const cookie = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('caf_dashboard_auth='))
      ?.slice('caf_dashboard_auth='.length);
    const expected = Buffer.from(
      `${config.dashboard.basicAuthUser}:${config.DASHBOARD_BASIC_AUTH_PASSWORD}`,
    ).toString('base64');

    if (cookie !== expected) {
      return reply.code(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Dashboard authentication required',
      });
    }
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Accel-Buffering', 'no');
  });

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
    // Send enough initial padding to force Cloudflare/Nginx to flush the SSE
    // response immediately; a tiny `:connected` frame may remain buffered.
    reply.raw.write(`:${' '.repeat(2048)}\n\n`);

    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(':heartbeat\n\n');
    }, 15000);

    const unsubscribe = eventBroadcaster.subscribe({
      write: (chunk: string) => reply.raw.write(chunk),
    });

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
