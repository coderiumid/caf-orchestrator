import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeEntry {
  value: string;
  expiresAt: number;
}

class FakeRedis {
  private store = new Map<string, FakeEntry>();

  constructor(private now: () => number) {}

  async set(
    key: string,
    value: string,
    _ex: 'EX',
    ttlSeconds: number,
    nx: 'NX',
  ): Promise<'OK' | null> {
    void nx;
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > this.now()) {
      return null;
    }
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    return 'OK';
  }
}

let currentTime = 1_751_587_200_000;
const fakeRedis = new FakeRedis(() => currentTime);

vi.mock('../../src/infrastructure/queue/connection.js', () => ({
  getRedisClient: () => fakeRedis,
}));

const { claimDelivery } = await import('../../src/infrastructure/linear/delivery-dedupe.js');

describe('claimDelivery', () => {
  beforeEach(() => {
    currentTime = 1_751_587_200_000;
  });

  const TTL_SECONDS = 86_400;

  it('claims a new delivery UUID successfully', async () => {
    const result = await claimDelivery('linear', '11111111-1111-4111-8111-111111111111', TTL_SECONDS);
    expect(result).toBe(true);
  });

  it('rejects the same delivery UUID claimed twice', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const first = await claimDelivery('linear', id, TTL_SECONDS);
    const second = await claimDelivery('linear', id, TTL_SECONDS);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('allows re-claiming the same UUID after the TTL has expired', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const first = await claimDelivery('linear', id, TTL_SECONDS);
    expect(first).toBe(true);

    currentTime += TTL_SECONDS * 1000 + 1;

    const second = await claimDelivery('linear', id, TTL_SECONDS);
    expect(second).toBe(true);
  });

  it('namespaces by source so linear and github IDs with the same value do not collide', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const linearClaim = await claimDelivery('linear', id, TTL_SECONDS);
    const githubClaim = await claimDelivery('github', id, TTL_SECONDS);

    expect(linearClaim).toBe(true);
    expect(githubClaim).toBe(true);
  });
});
