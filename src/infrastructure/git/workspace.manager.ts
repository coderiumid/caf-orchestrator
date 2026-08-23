import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { remove } from 'fs-extra';
import type { IWorkspaceManager } from '../../domain/interfaces/git.interface.js';
import { config } from '../../config/index.js';
import { ValidationError } from '../../domain/errors/app-errors.js';
import { logger } from '../logging/logger.js';

const WORKSPACE_ROOT = resolve(config.workspace.dir);

export class WorkspaceManager implements IWorkspaceManager {
  validatePath(dirPath: string): boolean {
    const resolved = resolve(dirPath);
    return resolved.startsWith(WORKSPACE_ROOT + '/') || resolved === WORKSPACE_ROOT;
  }

  async createWorkspace(): Promise<string> {
    const workspacePath = join(WORKSPACE_ROOT, `job-${randomUUID()}`);
    mkdirSync(workspacePath, { recursive: true });
    logger.debug('Workspace created', undefined, { path: workspacePath });
    return workspacePath;
  }

  async cleanupWorkspace(dirPath: string): Promise<void> {
    if (!this.validatePath(dirPath)) {
      throw new ValidationError(`Workspace path escape attempt detected: ${dirPath}`);
    }
    await remove(dirPath);
    logger.debug('Workspace removed', undefined, { path: dirPath });
  }
}
