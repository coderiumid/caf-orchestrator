import { describe, it, expect } from 'vitest';
import { WorkspaceLock } from '../../src/infrastructure/git/workspace-lock.js';
import { WorkspaceLockError } from '../../src/domain/errors/app-errors.js';

describe('WorkspaceLock', () => {
  it('acquires an unlocked key without throwing', () => {
    const lock = new WorkspaceLock();
    expect(() => lock.acquire('repo-a')).not.toThrow();
    expect(lock.isLocked('repo-a')).toBe(true);
  });

  it('rejects a second acquire on the same key while the first job still holds it (no queueing)', () => {
    const lock = new WorkspaceLock();
    lock.acquire('repo-a');

    expect(() => lock.acquire('repo-a')).toThrow(WorkspaceLockError);
  });

  it('allows re-acquiring a key after it has been released', () => {
    const lock = new WorkspaceLock();
    lock.acquire('repo-a');
    lock.release('repo-a');

    expect(lock.isLocked('repo-a')).toBe(false);
    expect(() => lock.acquire('repo-a')).not.toThrow();
  });

  it('locks are independent per key', () => {
    const lock = new WorkspaceLock();
    lock.acquire('repo-a');

    expect(() => lock.acquire('repo-b')).not.toThrow();
  });

  it('release on a key that was never locked is a no-op', () => {
    const lock = new WorkspaceLock();
    expect(() => lock.release('repo-a')).not.toThrow();
    expect(lock.isLocked('repo-a')).toBe(false);
  });
});
