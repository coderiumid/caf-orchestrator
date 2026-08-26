export interface IGitService {
  /** workspaceRoot defaults to the global workspace.dir config when omitted (e.g. PR-review jobs, which have no per-project registry entry). Every targetDir must resolve inside it — enforced as a path-escape guard. */
  clone(repoUrl: string, branch: string, targetDir: string, workspaceRoot?: string): Promise<void>;
  createBranch(targetDir: string, branch: string, workspaceRoot?: string): Promise<void>;
  commitAll(targetDir: string, message: string, workspaceRoot?: string): Promise<void>;
  push(targetDir: string, branch: string, workspaceRoot?: string): Promise<void>;
}

export interface IWorkspaceManager {
  /** rootDir defaults to the global workspace.dir config when omitted (e.g. PR-review jobs, which have no per-project registry entry). */
  createWorkspace(rootDir?: string): Promise<string>;
  cleanupWorkspace(dirPath: string, rootDir?: string): Promise<void>;
  validatePath(dirPath: string, rootDir?: string): boolean;
}
