import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { remove } from 'fs-extra';
import type { IWorkspaceManager, WorkspacePurpose } from '../../domain/interfaces/git.interface.js';
import { config } from '../../config/index.js';
import { ValidationError } from '../../domain/errors/app-errors.js';
import { logger } from '../logging/logger.js';
import { workspaceLock } from './workspace-lock.js';

const DEFAULT_WORKSPACE_ROOT = resolve(config.workspace.dir);

function isPersistentTicketPipeline(workspacePurpose?: WorkspacePurpose): boolean {
  return workspacePurpose === 'ticket-pipeline' && config.workspace.mode === 'persistent';
}

export class WorkspaceManager implements IWorkspaceManager {
  validatePath(dirPath: string, rootDir?: string): boolean {
    const root = rootDir ? resolve(rootDir) : DEFAULT_WORKSPACE_ROOT;
    const resolved = resolve(dirPath);
    return resolved.startsWith(root + '/') || resolved === root;
  }

  async createWorkspace(rootDir?: string, workspacePurpose?: WorkspacePurpose, repoIdentifier?: string): Promise<string> {
    const root = rootDir ? resolve(rootDir) : DEFAULT_WORKSPACE_ROOT;

    if (isPersistentTicketPipeline(workspacePurpose)) {
      if (!repoIdentifier) {
        throw new ValidationError('createWorkspace: repoIdentifier is required for persistent ticket-pipeline workspaces');
      }
      const workspacePath = join(root, `persistent-${repoIdentifier}`);
      workspaceLock.acquire(workspacePath);
      mkdirSync(workspacePath, { recursive: true });
      logger.debug('Persistent workspace acquired', undefined, { path: workspacePath });
      return workspacePath;
    }

    const workspacePath = join(root, `job-${randomUUID()}`);
    mkdirSync(workspacePath, { recursive: true });
    logger.debug('Workspace created', undefined, { path: workspacePath });
    return workspacePath;
  }

  async cleanupWorkspace(dirPath: string, rootDir?: string, workspacePurpose?: WorkspacePurpose): Promise<void> {
    if (!this.validatePath(dirPath, rootDir)) {
      throw new ValidationError(`Workspace path escape attempt detected: ${dirPath}`);
    }

    if (isPersistentTicketPipeline(workspacePurpose)) {
      workspaceLock.release(dirPath);
      logger.debug('Persistent workspace retained, lock released', undefined, { path: dirPath });
      return;
    }

    await remove(dirPath);
    logger.debug('Workspace removed', undefined, { path: dirPath });
  }
}
