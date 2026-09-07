import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { get, type IncomingMessage } from 'node:http';
import { eventsRoutes } from '../../src/presentation/web/routes/events.js';
import { eventBroadcaster, type DashboardEvent } from '../../src/presentation/web/sse/event-broadcaster.js';

// CAF-DASHBOARD-01 Task 4 verify: "buka 2 SSE client, ubah state.json di 2
// repo berbeda, konfirmasi tiap client terima event dengan repoId yang
// benar." The watcher→broadcaster wiring is covered by
// orchestration-state-watcher.test.ts; this exercises the actual HTTP route
// end to end — two real SSE connections over a real socket, asserting each
// receives the broadcast event with the correct repoId.
//
// Task 5 added auth to this route (reusing Bull Board's basic-auth) — these
// credentials match caf.config.yaml's `dashboard.basicAuthUser: admin` and
// tests/setup.ts's default DASHBOARD_BASIC_AUTH_PASSWORD.
const AUTH_HEADER = `Basic ${Buffer.from('admin:test-dashboard-password').toString('base64')}`;

function connectSse(port: number, authorization = AUTH_HEADER): Promise<{ res: IncomingMessage; frames: () => string[] }> {
  return new Promise((resolve, reject) => {
    const req = get(
      `http://127.0.0.1:${port}/api/events/stream`,
      { headers: { authorization } },
      (res) => {
        const chunks: string[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf-8')));
        // Give the connection handshake a moment before the caller starts asserting.
        setTimeout(() => resolve({ res, frames: () => chunks }), 50);
      },
    );
    req.on('error', reject);
  });
}

function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for condition'));
      setTimeout(check, 20);
    };
    check();
  });
}

describe('GET /api/events/stream', () => {
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    app = Fastify();
    await app.register(eventsRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a bound TCP address');
    port = address.port;
  });

  afterEach(async () => {
    await app.close();
  });

  it('delivers a broadcast event, tagged with the right repoId, to every connected client independently', async () => {
    const clientA = await connectSse(port);
    const clientB = await connectSse(port);

    const eventForRepoA: DashboardEvent = {
      repoId: 'ganjardbc/umkm-pos',
      ticketId: 'CAF-1',
      eventType: 'add',
      timestamp: '2026-09-07T00:00:00.000Z',
    };
    const eventForRepoB: DashboardEvent = {
      repoId: 'ganjardbc/other-repo',
      ticketId: 'CAF-2',
      eventType: 'change',
      timestamp: '2026-09-07T00:00:01.000Z',
    };

    eventBroadcaster.broadcast(eventForRepoA);
    eventBroadcaster.broadcast(eventForRepoB);

    await waitUntil(() => clientA.frames().join('').includes('CAF-2'));

    const receivedByA = clientA.frames().join('');
    const receivedByB = clientB.frames().join('');

    // Both clients see both events (SSE fan-out is not per-client filtered
    // server-side — filtering by repoId is a frontend concern, per Task 6).
    expect(receivedByA).toContain(`data: ${JSON.stringify(eventForRepoA)}`);
    expect(receivedByA).toContain(`data: ${JSON.stringify(eventForRepoB)}`);
    expect(receivedByB).toContain(`data: ${JSON.stringify(eventForRepoA)}`);
    expect(receivedByB).toContain(`data: ${JSON.stringify(eventForRepoB)}`);

    clientA.res.destroy();
    clientB.res.destroy();
  });

  it('rejects a connection with no auth header (401)', async () => {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = get(`http://127.0.0.1:${port}/api/events/stream`, resolve);
      req.on('error', reject);
    });
    expect(response.statusCode).toBe(401);
    response.destroy();
  });

  it('stops the broadcaster from writing to a client after it disconnects', async () => {
    const client = await connectSse(port);
    expect(eventBroadcaster.clientCount).toBeGreaterThanOrEqual(1);

    client.res.destroy();
    await waitUntil(() => eventBroadcaster.clientCount === 0);

    expect(eventBroadcaster.clientCount).toBe(0);
  });
});
