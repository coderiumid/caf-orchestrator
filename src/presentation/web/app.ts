import Fastify, { type FastifyError } from 'fastify';
import helmet from '@fastify/helmet';
import { pinoLogger } from '../../infrastructure/logging/logger.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { healthRoutes } from './routes/health.js';
import { webhookRoutes } from './routes/webhooks.js';
import { dashboardRoutes } from './routes/dashboard.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody: Buffer;
    startAt: bigint;
  }
}

export function buildApp() {
  const app = Fastify({
    loggerInstance: pinoLogger,
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
  });

  app.register(helmet);

  app.addHook('onRequest', (request, _reply, done) => {
    request.startAt = process.hrtime.bigint();
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const durationMs = Number(process.hrtime.bigint() - request.startAt) / 1e6;
    logger.info('Request completed', undefined, {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(durationMs),
    });
    done();
  });

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      try {
        const parsed = JSON.parse((body as Buffer).toString('utf-8')) as unknown;
        done(null, parsed);
      } catch {
        done(new Error('Invalid JSON body'));
      }
    },
  );

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const isServerError = statusCode >= 500;

    if (isServerError) {
      logger.error('Unhandled server error', error instanceof Error ? error : new Error(String(error)));
    }

    void reply.status(statusCode).send({
      statusCode,
      error: error.name ?? 'Error',
      message: isServerError ? 'An unexpected error occurred.' : error.message,
    });
  });

  app.get('/', async (_request, reply) => {
    return reply.send({ name: 'caf-orchestrator', status: 'running' });
  });

  app.register(healthRoutes);
  app.register(webhookRoutes, { prefix: '/webhooks' });
  app.register(dashboardRoutes);

  return app;
}
