import type { IGitService, IWorkspaceManager } from '../../domain/interfaces/git.interface.js';
import type { IAgentRunner } from '../../domain/interfaces/agent-runner.interface.js';
import type { IVcsClient } from '../../domain/interfaces/vcs-client.interface.js';
import type { PrReviewCommentContext, PrReviewJobPayload } from '../../domain/interfaces/queue.interface.js';
import { readFixReviewLog, type FixReviewLogEntry } from '../../infrastructure/reports/report-reader.js';
import { logger } from '../../infrastructure/logging/logger.js';

export interface RunPrReviewDeps {
  gitService: IGitService;
  workspaceManager: IWorkspaceManager;
  agentRunner: IAgentRunner;
  vcsClient: IVcsClient;
}

// Same branch naming convention run-agent-pipeline.use-case.ts writes
// (`ai-agent/${ticketKey}`) — a PR review job only ever targets a PR whose head
// branch this orchestrator created, so TICKET-ID is derived from it rather than
// carried as its own payload field (plan-checkpoint-b.md poin 4's payload sketch
// doesn't have one). A head branch that doesn't match this pattern means the PR
// wasn't produced by this pipeline — fail loud rather than guess a TICKET-ID.
const AI_AGENT_BRANCH_PATTERN = /^ai-agent\/(.+)$/;

function extractTicketKey(prHeadBranch: string): string {
  const match = AI_AGENT_BRANCH_PATTERN.exec(prHeadBranch);
  if (!match) {
    throw new Error(
      `PR head branch "${prHeadBranch}" does not match ai-agent/{TICKET-ID} — not a PR this pipeline produced`,
    );
  }
  return match[1];
}

function commentLabel(entry: { label: 'INLINE' | 'GENERAL'; path?: string; line?: number }): string {
  return entry.label === 'INLINE' ? `INLINE ${entry.path}:${entry.line}` : 'GENERAL';
}

// Prompt shape mirrors caf-initiator's `/caf-fix-review` spawnSection() contract
// (caf-initiator/src/templates/fix-review-command.js) — same label INLINE
// path:line / GENERAL, same scoped/global mode, same fix-review-log.md block
// format instruction — so caf-reviewer.md behaves identically whether spawned
// by the interactive command or this webhook-driven use-case.
function buildReviewerPrompt(ticketKey: string, mode: PrReviewJobPayload['mode'], commentContext: PrReviewCommentContext[]): string {
  // mode 'initial' carries no comments (webhooks.ts empties commentContext for
  // the "/caf-review" trigger — it's a command, not feedback) — swap the
  // per-comment block for an explicit full-review instruction instead of
  // emitting a "## Comment/Thread" header with nothing under it.
  const commentSection =
    commentContext.length === 0
      ? [
          '## Instruksi',
          'Lakukan review menyeluruh terhadap seluruh perubahan di PR ini — bukan',
          'respons ke comment tertentu. Tidak ada comment spesifik yang perlu ditanggapi.',
        ].join('\n')
      : [
          '## Comment/Thread',
          commentContext.map((c) => [`Comment ID: ${c.id}`, `Label: [${commentLabel(c)}]`, c.body].join('\n')).join('\n\n---\n\n'),
        ].join('\n\n');

  return [
    'Mode post-PR (bukan gate pipeline pre-PR biasa) — kamu menerima komentar reviewer manusia',
    'dari GitHub sebagai input tambahan.',
    '',
    `TICKET-ID: ${ticketKey}`,
    `Mode: ${mode}`,
    '',
    'Jangan `git push`, jangan panggil API GitHub apapun, jangan ubah status ticket di tracker —',
    `tulis \`.caf/tasks/${ticketKey}/fix-review-log.md\` saja. Reply ke GitHub dilakukan oleh caller`,
    'setelah kamu selesai.',
    '',
    commentSection,
    '',
    `Tulis \`.caf/tasks/${ticketKey}/fix-review-log.md\` dengan format:`,
    '```',
    `## Fix Review Log — ${ticketKey}`,
    'Generated: {timestamp}',
    `Triggered by: ${mode}`,
    '',
    '### Comment {Comment ID di atas, PERSIS sama} [{INLINE path:line | GENERAL}]',
    '> {kutipan comment asli, dipotong kalau panjang}',
    'Status: FIXED | SKIPPED | NOT_APPLICABLE',
    'Catatan: {alasan singkat, terutama wajib diisi untuk SKIPPED/NOT_APPLICABLE}',
    '```',
    'Satu blok `### Comment ...` per comment yang diproses.',
  ].join('\n');
}

function replyBody(entry: FixReviewLogEntry): string {
  return entry.note ? `${entry.status} — ${entry.note}` : entry.status;
}

function buildSummaryBody(ticketKey: string, mode: PrReviewJobPayload['mode'], entries: FixReviewLogEntry[]): string {
  const lines = entries.map((e) => `- [${e.status}] ${commentLabel(e)}: ${e.note || '(no note)'}`);
  return [
    `**Fix review (${mode})** — ${ticketKey}`,
    '',
    ...lines,
    '',
    `Detail: \`.caf/tasks/${ticketKey}/fix-review-log.md\``,
  ].join('\n');
}

export class RunPrReviewUseCase {
  constructor(private readonly deps: RunPrReviewDeps) {}

  async execute(job: PrReviewJobPayload): Promise<void> {
    const { gitService, workspaceManager, agentRunner, vcsClient } = this.deps;

    // Validate before creating a workspace — a throw here must not leave an
    // orphaned workspace dir behind (this line runs outside the try/finally).
    const ticketKey = extractTicketKey(job.prHeadBranch);
    const [owner, repo] = job.repoFullName.split('/');

    const workspacePath = await workspaceManager.createWorkspace();
    const repoPath = `${workspacePath}/repo`;

    logger.info('PR review job started', undefined, {
      jobId: job.jobId,
      prNumber: job.prNumber,
      ticketKey,
      mode: job.mode,
    });

    try {
      await gitService.clone(job.cloneUrl, job.prHeadBranch, repoPath);

      const prompt = buildReviewerPrompt(ticketKey, job.mode, job.commentContext);
      const result = await agentRunner.run('caf-reviewer', repoPath, prompt);
      logger.info('caf-reviewer agent run result', undefined, {
        jobId: job.jobId,
        ticketKey,
        agentName: 'caf-reviewer',
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (result.signal || result.exitCode !== 0) {
        logger.error('caf-reviewer agent run failed', undefined, {
          jobId: job.jobId,
          ticketKey,
          agentName: 'caf-reviewer',
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
      if (result.signal) {
        throw new Error(`caf-reviewer agent killed by signal ${result.signal}`);
      }
      if (result.exitCode !== 0) {
        throw new Error(`caf-reviewer agent exited with code ${result.exitCode}: ${result.stderr}`);
      }

      const fixReviewLog = await readFixReviewLog(repoPath, ticketKey);
      if (!fixReviewLog) {
        throw new Error('No fix-review-log.md produced');
      }

      for (const entry of fixReviewLog.entries) {
        if (entry.label !== 'INLINE') continue;
        const commentId = Number(entry.commentRef);
        if (!Number.isFinite(commentId)) {
          // Mode 'initial' sends the reviewer no real Comment IDs to echo
          // (webhooks.ts empties commentContext for "/caf-review" — see
          // buildReviewerPrompt's full-review branch), so a non-numeric
          // commentRef here is the reviewer logging a self-found finding, not
          // an error — log at info instead of warn to avoid false-alarming
          // on the expected case. Any other mode DOES supply real IDs, so a
          // non-numeric commentRef there is unexpected and stays a warning.
          const log = job.mode === 'initial' ? logger.info : logger.warn;
          log('fix-review-log entry has non-numeric commentRef, skipping reply', undefined, {
            jobId: job.jobId,
            ticketKey,
            mode: job.mode,
            commentRef: entry.commentRef,
          });
          continue;
        }
        await vcsClient.replyToReviewComment({ owner, repo, prNumber: job.prNumber, commentId, body: replyBody(entry) });
      }

      await vcsClient.postIssueComment({
        owner,
        repo,
        issueNumber: job.prNumber,
        body: buildSummaryBody(ticketKey, job.mode, fixReviewLog.entries),
      });

      logger.info('PR review job completed', undefined, {
        jobId: job.jobId,
        ticketKey,
        prNumber: job.prNumber,
        entryCount: fixReviewLog.entries.length,
      });
    } finally {
      await workspaceManager.cleanupWorkspace(workspacePath);
    }
  }
}
