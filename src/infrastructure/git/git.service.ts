import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { IGitService } from '../../domain/interfaces/git.interface.js';
import { config } from '../../config/index.js';
import { GitError, ValidationError } from '../../domain/errors/app-errors.js';
import { logger } from '../logging/logger.js';
import { isSafeBranchName } from '../vcs/security.js';

const DEFAULT_WORKSPACE_ROOT = resolve(config.workspace.dir);
const CLONE_DEPTH = 50;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_AUTHOR_NAME: 'Ganjar Hadiatna',
  GIT_AUTHOR_EMAIL: 'ganjardbc@gmail.com',
  GIT_COMMITTER_NAME: 'Ganjar Hadiatna',
  GIT_COMMITTER_EMAIL: 'ganjardbc@gmail.com',
};

function getAuthenticatedRepoUrl(repoUrl: string): string {
  if (repoUrl.startsWith('https://github.com/') && config.GITHUB_TOKEN) {
    return repoUrl.replace('https://github.com/', `https://x-access-token:${config.GITHUB_TOKEN}@github.com/`);
  }
  return repoUrl;
}

function assertInsideWorkspace(dirPath: string, workspaceRoot?: string): void {
  const root = workspaceRoot ? resolve(workspaceRoot) : DEFAULT_WORKSPACE_ROOT;
  const resolved = resolve(dirPath);
  if (!resolved.startsWith(root + '/') && resolved !== root) {
    throw new ValidationError(`Path escape attempt detected: ${dirPath}`);
  }
}

function assertSafeBranchName(branch: string): void {
  if (!isSafeBranchName(branch)) {
    throw new ValidationError(`Unsafe branch name rejected: ${branch}`);
  }
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));

    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(out).toString('utf-8'));
      } else {
        const msg = Buffer.concat(err).toString('utf-8').trim();
        reject(new GitError(`git ${args[0]} failed (${code ?? signal}): ${msg}`));
      }
    });

    proc.on('error', (spawnErr) => {
      reject(new GitError(`git spawn error: ${spawnErr.message}`));
    });
  });
}

export class GitService implements IGitService {
  async clone(repoUrl: string, branch: string, targetDir: string, workspaceRoot?: string): Promise<void> {
    assertInsideWorkspace(targetDir, workspaceRoot);
    assertSafeBranchName(branch);

    const authenticatedUrl = getAuthenticatedRepoUrl(repoUrl);
    logger.info('Cloning repository', undefined, { repoUrl: repoUrl.replace(/:[^@]+@/, ':***@'), branch });

    await runGit(
      [
        'clone',
        '--depth', String(CLONE_DEPTH),
        '--single-branch',
        '--branch', branch,
        '--',
        authenticatedUrl,
        targetDir,
      ],
      workspaceRoot ? resolve(workspaceRoot) : DEFAULT_WORKSPACE_ROOT,
    );

    logger.debug('Clone complete', undefined, { targetDir });
  }

  async createBranch(targetDir: string, branch: string, workspaceRoot?: string): Promise<void> {
    assertInsideWorkspace(targetDir, workspaceRoot);
    assertSafeBranchName(branch);

    logger.debug('Creating branch', undefined, { branch });
    await runGit(['checkout', '-b', branch], targetDir);
  }

  async commitAll(targetDir: string, message: string, workspaceRoot?: string): Promise<void> {
    assertInsideWorkspace(targetDir, workspaceRoot);

    await runGit(['add', '-A'], targetDir);
    await runGit(['commit', '-m', message, '--allow-empty'], targetDir);
    logger.debug('Committed changes', undefined, { targetDir });
  }

  async push(targetDir: string, branch: string, workspaceRoot?: string): Promise<void> {
    assertInsideWorkspace(targetDir, workspaceRoot);
    assertSafeBranchName(branch);

    logger.info('Pushing branch', undefined, { branch });
    await runGit(['push', '--set-upstream', 'origin', branch], targetDir);
  }
}
