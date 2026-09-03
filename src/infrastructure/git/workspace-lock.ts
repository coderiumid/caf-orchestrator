import type { IWorkspaceLock } from '../../domain/interfaces/git.interface.js';
import { WorkspaceLockError } from '../../domain/errors/app-errors.js';

// Map<key, held> — a plain in-memory table is sufficient because
// caf-orchestrator runs as a single worker process on one VPS instance
// (CAF-WSMODE-01, requirements.md STOP item #2). Revisit with a Redis-backed
// lock if the deployment topology ever moves to multiple worker instances.
export class WorkspaceLock implements IWorkspaceLock {
  private readonly held = new Map<string, boolean>();

  acquire(key: string): void {
    if (this.held.get(key)) {
      throw new WorkspaceLockError(`Workspace "${key}" is busy — another job is already using it. Try again later.`);
    }
    this.held.set(key, true);
  }

  release(key: string): void {
    this.held.delete(key);
  }

  isLocked(key: string): boolean {
    return this.held.get(key) === true;
  }
}

// Shared singleton: lock state must persist across job invocations within
// the same worker process, not be re-created per call site.
export const workspaceLock = new WorkspaceLock();
