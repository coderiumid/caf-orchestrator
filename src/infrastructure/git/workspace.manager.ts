import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { remove } from 'fs-extra';
import type { IWorkspaceManager } from '../../domain/interfaces/git.interface.js';
import { config } from '../../config/index.js';
import { ValidationError } from '../../domain/errors/app-errors.js';
import { logger } from '../logging/logger.js';

const DEFAULT_WORKSPACE_ROOT = resolve(config.workspace.dir);

export class WorkspaceManager implements IWorkspaceManager {
  validatePath(dirPath: string, rootDir?: string): boolean {
    const root = rootDir ? resolve(rootDir) : DEFAULT_WORKSPACE_ROOT;
    const resolved = resolve(dirPath);
    return resolved.startsWith(root + '/') || resolved === root;
  }

  async createWorkspace(rootDir?: string): Promise<string> {
    const root = rootDir ? resolve(rootDir) : DEFAULT_WORKSPACE_ROOT;
    const workspacePath = join(root, `job-${randomUUID()}`);
    mkdirSync(workspacePath, { recursive: true });
    logger.debug('Workspace created', undefined, { path: workspacePath });
    return workspacePath;
  }

  async cleanupWorkspace(dirPath: string, rootDir?: string): Promise<void> {
    if (!this.validatePath(dirPath, rootDir)) {
      throw new ValidationError(`Workspace path escape attempt detected: ${dirPath}`);
    }
    await remove(dirPath);
    logger.debug('Workspace removed', undefined, { path: dirPath });
  }
}
