export interface IGitService {
  clone(repoUrl: string, branch: string, targetDir: string): Promise<void>;
  createBranch(targetDir: string, branch: string): Promise<void>;
  commitAll(targetDir: string, message: string): Promise<void>;
  push(targetDir: string, branch: string): Promise<void>;
}

export interface IWorkspaceManager {
  createWorkspace(): Promise<string>;
  cleanupWorkspace(dirPath: string): Promise<void>;
  validatePath(dirPath: string): boolean;
}
