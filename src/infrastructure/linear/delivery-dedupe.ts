import { getRedisClient } from '../queue/connection.js';

/**
 * Records a delivery ID (Linear-Delivery / X-GitHub-Delivery) in Redis with a
 * TTL, namespaced by source so the two providers' UUID spaces never collide.
 * Returns false if the ID was already seen (i.e. this delivery is a
 * replay/redelivery and should be rejected), true if it's new.
 */
export async function claimDelivery(
  source: 'linear' | 'github',
  deliveryId: string,
  ttlSeconds: number,
): Promise<boolean> {
  const redis = getRedisClient();
  const key = `${source}:delivery:${deliveryId}`;
  const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}
