import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import basicAuth from '@fastify/basic-auth';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { config } from '../../../config/index.js';
import { rawPipelineQueue } from '../../../infrastructure/queue/client.js';

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers so failure timing
    // doesn't leak the correct credential length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  if (!config.dashboard.enabled) {
    return;
  }

  const expectedUser = config.dashboard.basicAuthUser as string;
  const expectedPassword = config.DASHBOARD_BASIC_AUTH_PASSWORD as string;

  await app.register(basicAuth, {
    validate: (username, password, _req, _reply, done) => {
      const userOk = timingSafeCompare(username, expectedUser);
      const passOk = timingSafeCompare(password, expectedPassword);
      done(userOk && passOk ? undefined : new Error('Unauthorized'));
    },
    authenticate: { realm: 'caf-orchestrator dashboard' },
  });

  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: [new BullMQAdapter(rawPipelineQueue)],
    serverAdapter,
  });

  await app.register(async (instance) => {
    instance.addHook('onRequest', instance.basicAuth);
    await instance.register(serverAdapter.registerPlugin(), { prefix: '/admin/queues' });
  });
}
