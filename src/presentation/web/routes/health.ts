import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
import { getRedisClient } from '../../../infrastructure/queue/connection.js';

type ServiceStatus = 'up' | 'down';

interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  services: {
    redis: ServiceStatus;
    disk: ServiceStatus;
  };
}

async function checkDisk(): Promise<ServiceStatus> {
  const probe = join(config.workspace.dir, `.health-probe-${randomBytes(4).toString('hex')}`);
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(config.workspace.dir, { recursive: true });
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return 'up';
  } catch {
    return 'down';
  }
}

async function checkRedis(): Promise<ServiceStatus> {
  try {
    const redis = getRedisClient();
    const pong = await redis.ping();
    return pong === 'PONG' ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const [redis, disk] = await Promise.all([checkRedis(), checkDisk()]);

    const allUp = redis === 'up' && disk === 'up';
    const body: HealthResponse = {
      status: allUp ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      services: { redis, disk },
    };

    return reply.status(allUp ? 200 : 503).send(body);
  });
}
