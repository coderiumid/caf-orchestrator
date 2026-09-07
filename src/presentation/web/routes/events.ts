import type { FastifyInstance } from 'fastify';
import { eventBroadcaster } from '../sse/event-broadcaster.js';

/**
 * CAF-DASHBOARD-01 Task 4: SSE push endpoint. Auth deliberately not added here —
 * Task 5 (REST endpoints) is the explicit task that reuses Bull Board's basic-auth
 * middleware across the whole dashboard surface; adding it piecemeal here would
 * pre-empt that and risk a second, drifting auth wrapper.
 */
export async function eventsRoutes(app: FastifyInstance): Promise<void> {
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
