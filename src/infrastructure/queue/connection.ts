import IORedis from 'ioredis';
import { config } from '../../config/index.js';
import { logger } from '../logging/logger.js';

export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
}

export function getRedisConnectionOptions(): RedisConnectionOptions {
  const url = new URL(config.REDIS_URL);
  return {
    host: url.hostname,
    port: parseInt(url.port, 10) || 6379,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

let client: IORedis | null = null;

export function getRedisClient(): IORedis {
  if (!client) {
    client = new IORedis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    client.on('error', (err: Error) => {
      logger.error('Redis client error', err);
    });

    client.on('connect', () => {
      logger.info('Redis connected');
    });

    client.on('reconnecting', () => {
      logger.warn('Redis reconnecting');
    });
  }

  return client;
}

export async function closeRedisConnection(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
