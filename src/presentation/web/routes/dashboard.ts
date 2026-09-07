import type { FastifyInstance } from 'fastify';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { config } from '../../../config/index.js';
import { rawPipelineQueue } from '../../../infrastructure/queue/client.js';
import { registerDashboardBasicAuth } from '../auth/dashboard-basic-auth.js';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  if (!config.dashboard.enabled) {
    return;
  }

  await registerDashboardBasicAuth(app);

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
