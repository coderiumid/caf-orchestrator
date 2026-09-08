import IORedis from 'ioredis';
import { config } from '../../config/index.js';
import { logger } from '../logging/logger.js';
import type { DashboardEvent } from '../../presentation/web/sse/event-broadcaster.js';

const CHANNEL = 'caf:dashboard:events';

/**
 * Cross-process nudge for the dashboard's SSE broadcaster. The web server and
 * BullMQ worker are two separate OS processes (see CLAUDE.md) — but
 * recordAgentEvent/recordPipelineStarted/finalizePipelineRun (the real
 * progress writes) only ever run inside the worker, while eventBroadcaster's
 * SSE clients only ever connect to the web server. An in-memory Set can't
 * cross that boundary, so this rides the same Redis instance BullMQ already
 * requires instead.
 */

let publisher: IORedis | null = null;

function getPublisher(): IORedis | null {
  if (publisher) return publisher;
  // config.REDIS_URL is absent in several unit tests that mock the config
  // module with a partial shape (they don't exercise Redis at all) — treat
  // that as "not configured" and no-op silently, not a runtime failure.
  if (!config.REDIS_URL) return null;
  try {
    publisher = new IORedis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3, enableReadyCheck: true });
    publisher.on('error', (err: Error) => logger.error('Dashboard event publisher Redis error', err));
    return publisher;
  } catch {
    return null;
  }
}

export function publishDashboardEvent(event: DashboardEvent): void {
  const client = getPublisher();
  if (!client) return;
  client.publish(CHANNEL, JSON.stringify(event)).catch((err: unknown) => {
    logger.warn('Dashboard event publish failed — live update skipped, next reload will still show it', undefined, {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Web-server-only: fans Redis-published dashboard events out to onEvent (wire it to eventBroadcaster.broadcast). Returns a close function for graceful shutdown. */
export function subscribeDashboardEvents(onEvent: (event: DashboardEvent) => void): { close: () => Promise<void> } {
  const subscriber = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: true });
  subscriber.on('error', (err: Error) => logger.error('Dashboard event subscriber Redis error', err));
  subscriber.subscribe(CHANNEL).catch((err: unknown) => {
    logger.error('Failed to subscribe to dashboard events channel', err instanceof Error ? err : new Error(String(err)));
  });
  subscriber.on('message', (channel: string, message: string) => {
    if (channel !== CHANNEL) return;
    try {
      onEvent(JSON.parse(message) as DashboardEvent);
    } catch (err) {
      logger.warn('Failed to parse dashboard event message', undefined, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return { close: () => subscriber.quit().then(() => undefined) };
}
