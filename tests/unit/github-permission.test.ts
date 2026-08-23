import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkReviewPermission } from '../../src/infrastructure/vcs/github-permission.js';

function mockFetchOnce(response: { ok: boolean; json?: () => Promise<unknown> }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: response.ok,
      json: response.json ?? (() => Promise.resolve({})),
    }),
  );
}

describe('checkReviewPermission', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['write', 'maintain', 'admin'])('returns true for permission %s', async (permission) => {
    mockFetchOnce({ ok: true, json: () => Promise.resolve({ permission }) });
    const result = await checkReviewPermission('owner', 'repo', 'user');
    expect(result).toBe(true);
  });

  it.each(['read', 'none'])('returns false for permission %s', async (permission) => {
    mockFetchOnce({ ok: true, json: () => Promise.resolve({ permission }) });
    const result = await checkReviewPermission('owner', 'repo', 'user');
    expect(result).toBe(false);
  });

  it('returns false without throwing when the response is not ok (e.g. 404 non-collaborator)', async () => {
    mockFetchOnce({ ok: false });
    const result = await checkReviewPermission('owner', 'repo', 'user');
    expect(result).toBe(false);
  });
});
