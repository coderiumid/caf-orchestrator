import { config, projectRegistry } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { buildApp } from './app.js';
import { pipelineQueue } from '../../infrastructure/queue/client.js';
import { closeRedisConnection } from '../../infrastructure/queue/connection.js';
import { startOrchestrationStateWatchers } from '../../infrastructure/watch/orchestration-state-watcher.js';
import { eventBroadcaster } from './sse/event-broadcaster.js';

const app = buildApp();

// CAF-DASHBOARD-01 Task 4: one watcher per configured project, feeding every
// orchestration-state.json add/change/unlink to the SSE broadcaster. Started
// here (not in buildApp()) so tests that build the app via buildApp() don't
// spin up real filesystem watchers against project workspaceDirs that may
// not exist in a test environment.
const stateWatchers = startOrchestrationStateWatchers(projectRegistry.getAll(), (event) =>
  eventBroadcaster.broadcast(event),
);

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
    await Promise.all(stateWatchers.map((watcher) => watcher.close()));
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
