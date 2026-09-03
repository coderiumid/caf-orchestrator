export interface PreflightCleanupResult {
  /** Whether the workspace had uncommitted changes (tracked or untracked) before the reset. */
  hadUncommittedChanges: boolean;
  /** Branch that was checked out before the reset — part of the audit trail when hadUncommittedChanges is true. */
  branchBeforeReset: string;
  /** HEAD commit before the reset — part of the audit trail when hadUncommittedChanges is true. */
  headCommitBeforeReset: string;
  /** `git status --short` output before the reset (empty string when clean). */
  statusBeforeReset: string;
}

export interface IGitService {
  /** workspaceRoot defaults to the global workspace.dir config when omitted (e.g. PR-review jobs, which have no per-project registry entry). Every targetDir must resolve inside it — enforced as a path-escape guard. */
  clone(repoUrl: string, branch: string, targetDir: string, workspaceRoot?: string): Promise<void>;
  createBranch(targetDir: string, branch: string, workspaceRoot?: string): Promise<void>;
  commitAll(targetDir: string, message: string, workspaceRoot?: string): Promise<void>;
  push(targetDir: string, branch: string, workspaceRoot?: string): Promise<void>;
  /**
   * Persistent-mode reuse prep (CAF-WSMODE-01): fetch, discard any local
   * state, and land the workspace on a clean `baseBranch` synced to
   * `origin/baseBranch`. Destructive (`reset --hard` + `clean -fd`) —
   * only ever call this against caf-orchestrator's own workspace clone,
   * never a human's working directory. If uncommitted changes are found,
   * they are logged (branch, HEAD commit, `git status --short`) before
   * being discarded, so the loss is auditable, not silent.
   */
  preflightCleanup(targetDir: string, baseBranch: string, workspaceRoot?: string): Promise<PreflightCleanupResult>;
}

export interface IWorkspaceManager {
  /** rootDir defaults to the global workspace.dir config when omitted (e.g. PR-review jobs, which have no per-project registry entry). */
  createWorkspace(rootDir?: string): Promise<string>;
  cleanupWorkspace(dirPath: string, rootDir?: string): Promise<void>;
  validatePath(dirPath: string, rootDir?: string): boolean;
}

/**
 * In-memory, per-process lock over a persistent-mode workspace key (e.g. a
 * repo name). One caf-orchestrator worker process on a single VPS instance —
 * no cross-instance coordination (Redis, file lock) needed (CAF-WSMODE-01,
 * see requirements.md STOP item #2). Reject-immediately, not queued: acquire
 * throws WorkspaceLockError synchronously if the key is already held.
 */
export interface IWorkspaceLock {
  acquire(key: string): void;
  release(key: string): void;
  isLocked(key: string): boolean;
}
