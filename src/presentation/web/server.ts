import { config } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { buildApp } from './app.js';
import { pipelineQueue } from '../../infrastructure/queue/client.js';
import { closeRedisConnection } from '../../infrastructure/queue/connection.js';

const app = buildApp();

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.server.port, host: '0.0.0.0' });
    logger.info(`Server listening on port ${config.server.port}`);
  } catch (err) {
    logger.fatal('Failed to start server', err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully`);
  try {
    await app.close();
    await pipelineQueue.close();
    await closeRedisConnection();
    logger.info('Server closed');
    process.exit(0);
  } catch (err) {
    logger.fatal('Error during shutdown', err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void start();
