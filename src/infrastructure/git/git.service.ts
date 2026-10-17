import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { IGitService, PreflightCleanupResult, WorkspaceStatus } from '../../domain/interfaces/git.interface.js';
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

const GITHUB_PREFIX = 'https://github.com/';
const GITHUB_EXTRAHEADER_KEY = 'http.https://github.com/.extraheader';
const MIN_GIT_VERSION = { major: 2, minor: 31 };

let gitVersionCheck: Promise<void> | undefined;

/** Test seam: forget the cached `git --version` result. */
export function resetGitVersionCheck(): void {
  gitVersionCheck = undefined;
}

/** Strips userinfo (`user:token@`) from an https URL; other input is returned unchanged. */
export function toCleanRepoUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]+@/, '$1');
}

function authSecrets(): string[] {
  const token = config.GITHUB_TOKEN;
  if (!token) return [];
  return [token, Buffer.from(`x-access-token:${token}`).toString('base64')];
}

function redactSecrets(text: string): string {
  return authSecrets().reduce((acc, secret) => acc.split(secret).join('***'), text);
}

function assertGitSupportsConfigEnv(): Promise<void> {
  gitVersionCheck ??= runGit(['--version'], process.cwd()).then((out) => {
    const m = /(\d+)\.(\d+)/.exec(out);
    const major = m ? Number(m[1]) : 0;
    const minor = m ? Number(m[2]) : 0;
    if (major < MIN_GIT_VERSION.major || (major === MIN_GIT_VERSION.major && minor < MIN_GIT_VERSION.minor)) {
      throw new GitError(
        `git ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} or newer is required to authenticate via GIT_CONFIG_COUNT (found: ${out.trim()})`,
        null,
      );
    }
  });
  // A failed check must not stay cached forever (e.g. transient spawn error).
  gitVersionCheck.catch(() => {
    gitVersionCheck = undefined;
  });
  return gitVersionCheck;
}

/**
 * Extra env that authenticates one network git command against github.com
 * (CAF-SDD-04g). The token travels only in the child's env as an
 * `http.<url>.extraheader` config entry — never in argv, `.git/config` or the
 * remote URL. Returns `{}` without a token or for non-github.com URLs.
 */
export async function buildGitAuthEnv(repoUrl: string): Promise<NodeJS.ProcessEnv> {
  const token = config.GITHUB_TOKEN;
  if (!token || !toCleanRepoUrl(repoUrl).startsWith(GITHUB_PREFIX)) return {};
  await assertGitSupportsConfigEnv();
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: GITHUB_EXTRAHEADER_KEY,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

async function authEnvForOrigin(cwd: string): Promise<NodeJS.ProcessEnv> {
  const origin = (await runGit(['remote', 'get-url', 'origin'], cwd)).trim();
  return buildGitAuthEnv(origin);
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

function runGit(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: { ...GIT_ENV, ...extraEnv },
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
        const msg = redactSecrets(Buffer.concat(err).toString('utf-8').trim());
        reject(new GitError(`git ${args[0]} failed (${code ?? signal}): ${msg}`, code));
      }
    });

    proc.on('error', (spawnErr) => {
      reject(new GitError(`git spawn error: ${redactSecrets(spawnErr.message)}`));
    });
  });
}

export class GitService implements IGitService {
  async clone(repoUrl: string, branch: string, targetDir: string, workspaceRoot?: string): Promise<void> {
    assertInsideWorkspace(targetDir, workspaceRoot);
    assertSafeBranchName(branch);

    const cleanUrl = toCleanRepoUrl(repoUrl);
    const authEnv = await buildGitAuthEnv(cleanUrl);
    logger.info('Cloning repository', undefined, { repoUrl: cleanUrl, branch });

    await runGit(
      [
        'clone',
        '--depth', String(CLONE_DEPTH),
        '--single-branch',
        '--branch', branch,
        '--',
        cleanUrl,
        targetDir,
      ],
      workspaceRoot ? resolve(workspaceRoot) : DEFAULT_WORKSPACE_ROOT,
      authEnv,
    );

    logger.debug('Clone complete', undefined, { targetDir });
  }

  async createBranch(targetDir: string, branch: string, workspaceRoot?: string): Promise<void> {
    assertInsideWorkspace(targetDir, workspaceRoot);
    assertSafeBranchName(branch);

    logger.debug('Creating branch', undefined, { branch });
    await runGit(['checkout', '-b', branch, '--'], targetDir);
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
    await runGit(['push', '--set-upstream', 'origin', '--', branch], targetDir, await authEnvForOrigin(targetDir));
  }

  async preflightCleanup(targetDir: string, baseBranch: string, workspaceRoot?: string): Promise<PreflightCleanupResult> {
    assertInsideWorkspace(targetDir, workspaceRoot);
    assertSafeBranchName(baseBranch);

    logger.debug('Preflight cleanup: fetching', undefined, { targetDir });
    // Older clones were made with a token-bearing origin URL; scrub it before
    // anything else so the token stops living in .git/config (CAF-SDD-04g).
    const originUrl = (await runGit(['remote', 'get-url', 'origin'], targetDir)).trim();
    const cleanOrigin = toCleanRepoUrl(originUrl);
    if (cleanOrigin !== originUrl) {
      await runGit(['remote', 'set-url', 'origin', cleanOrigin], targetDir);
      logger.info('Preflight cleanup: removed credentials from origin URL', undefined, { targetDir });
    }
    await runGit(['fetch', 'origin'], targetDir, await buildGitAuthEnv(cleanOrigin));

    const branchBeforeReset = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], targetDir)).trim();
    const headCommitBeforeReset = (await runGit(['rev-parse', 'HEAD'], targetDir)).trim();
    const statusBeforeReset = (await runGit(['status', '--short'], targetDir)).trim();
    const hadUncommittedChanges = statusBeforeReset.length > 0;

    // Audit trail required before the destructive reset below discards this
    // state — logged only when there's actually something to lose, so a
    // routine clean-workspace cleanup doesn't spam the log (CAF-WSMODE-01).
    if (hadUncommittedChanges) {
      logger.warn('Preflight cleanup: discarding uncommitted changes before reset', undefined, {
        targetDir,
        branch: branchBeforeReset,
        headCommit: headCommitBeforeReset,
        status: statusBeforeReset,
      });
    }

    await runGit(['checkout', baseBranch, '--'], targetDir);
    await runGit(['reset', '--hard', `origin/${baseBranch}`], targetDir);
    await runGit(['clean', '-fd'], targetDir);

    logger.info('Preflight cleanup complete', undefined, { targetDir, baseBranch, hadUncommittedChanges });

    return { hadUncommittedChanges, branchBeforeReset, headCommitBeforeReset, statusBeforeReset };
  }

  async remoteBranchExists(repoUrl: string, branch: string, cwd: string): Promise<boolean> {
    assertSafeBranchName(branch);
    const cleanUrl = toCleanRepoUrl(repoUrl);
    const authEnv = await buildGitAuthEnv(cleanUrl);
    try {
      const out = await runGit(['ls-remote', '--exit-code', '--heads', cleanUrl, branch], cwd, authEnv);
      return out.trim().length > 0;
    } catch (err) {
      // exit code 2 = ls-remote ran fine but found no matching ref — the
      // branch genuinely doesn't exist, distinct from an auth/network
      // failure (other exit codes), which should propagate and let the
      // normal error path handle it.
      if (err instanceof GitError && err.exitCode === 2) {
        return false;
      }
      throw err;
    }
  }

  async getHeadCommit(targetDir: string): Promise<string> {
    return (await runGit(['rev-parse', 'HEAD'], targetDir)).trim();
  }

  async getWorkspaceStatus(targetDir: string, workspaceRoot?: string): Promise<WorkspaceStatus> {
    assertInsideWorkspace(targetDir, workspaceRoot);
    const statusOutput = (await runGit(['status', '--short'], targetDir)).trim();
    return { hasUncommittedChanges: statusOutput.length > 0, statusOutput };
  }

  async diffStat(targetDir: string, fromSha: string, toSha: string, workspaceRoot?: string): Promise<string> {
    assertInsideWorkspace(targetDir, workspaceRoot);
    return (await runGit(['diff', `${fromSha}..${toSha}`, '--stat'], targetDir)).trim();
  }
}
