import type { IGitService, IWorkspaceManager } from '../../domain/interfaces/git.interface.js';
import type { IAgentRunner } from '../../domain/interfaces/agent-runner.interface.js';
import type { IVcsClient, PullRequestReviewEvent } from '../../domain/interfaces/vcs-client.interface.js';
import type { PrReviewCommentContext, PrReviewJobPayload } from '../../domain/interfaces/queue.interface.js';
import type { INotifier } from '../../domain/interfaces/notifier.interface.js';
import {
  readFixReviewLog,
  readInitialReviewReport,
  type FixReviewLogEntry,
  type InitialReviewVerdict,
} from '../../infrastructure/reports/report-reader.js';
import { SelfReviewRejectedError } from '../../domain/errors/app-errors.js';
import { logger } from '../../infrastructure/logging/logger.js';

// Identical to review-command.js's (caf-initiator) mapping table —
// APPROVE→APPROVE, CHANGES REQUESTED→REQUEST_CHANGES, DEFER→COMMENT. Not
// reinterpreted here, just mirrored (CAF-ORCH-PRREVIEW-03 non-negotiable).
const VERDICT_TO_EVENT: Record<InitialReviewVerdict, PullRequestReviewEvent> = {
  APPROVE: 'APPROVE',
  CHANGES_REQUESTED: 'REQUEST_CHANGES',
  DEFER: 'COMMENT',
};

function verdictLabel(verdict: InitialReviewVerdict): string {
  return verdict === 'CHANGES_REQUESTED' ? 'CHANGES REQUESTED' : verdict;
}

export interface RunPrReviewDeps {
  gitService: IGitService;
  workspaceManager: IWorkspaceManager;
  agentRunner: IAgentRunner;
  vcsClient: IVcsClient;
  notifier?: INotifier;
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
//
// CAF-ORCH-PRREVIEW-03: unchanged, kept byte-for-byte — only reachable for
// mode `scoped`/`global` now (see buildReviewerPrompt below). Mode `initial`
// moved to buildInitialReviewPrompt(), a real INITIAL-mode (Verdict-producing)
// prompt equivalent to caf-initiator's `/caf-review` (review-command.js
// spawnSection()), not this fix-review-log contract.
function buildFixReviewPrompt(ticketKey: string, mode: PrReviewJobPayload['mode'], commentContext: PrReviewCommentContext[]): string {
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

// INITIAL mode — mirrors caf-initiator's `/caf-review` spawnSection()
// (caf-initiator/src/templates/review-command.js) contract: a full review of
// this PR's diff from scratch, `commentContext = []`, writing
// `review-notes.md` (Ticket, Agent, Verdict, Security Audit, Qualitative
// Review, Verdict Rationale, For Developer) — NOT the fix-review-log.md
// contract above. mode is always 'initial' here (only call site), kept as a
// param for symmetry with buildFixReviewPrompt/logging.
function buildInitialReviewPrompt(ticketKey: string, mode: PrReviewJobPayload['mode']): string {
  return [
    'Mode INITIAL (bukan fix-review post-PR) — full review dari awal terhadap seluruh',
    'perubahan PR ini, setara kontrak `/caf-review` interaktif. Tidak ada comment reviewer',
    'manusia yang perlu ditanggapi (commentContext kosong) — bukan respons ke comment tertentu.',
    '',
    `TICKET-ID: ${ticketKey}`,
    `Mode: ${mode}`,
    '',
    'Jangan `git push`, jangan panggil API GitHub apapun, jangan ubah status ticket di tracker,',
    'jangan fix kode apapun — tulis `review-notes.md` saja, format seperti biasa (Verdict,',
    'Security Audit, Qualitative Review, dll). Komunikasi balik ke GitHub (posting PR Review)',
    'adalah tugas caller, dilakukan setelah kamu selesai.',
    '',
    `Tulis \`.caf/tasks/${ticketKey}/review-notes.md\` dengan format standar caf-reviewer.md:`,
    '```',
    `## Review Notes — ${ticketKey}`,
    'Ticket: {TICKET-ID}',
    'Agent: caf-reviewer',
    'Verdict: APPROVE | CHANGES REQUESTED | DEFER',
    '',
    '### Security Audit',
    '{temuan keamanan, atau "None" kalau tidak ada}',
    '',
    '### Qualitative Review',
    '{catatan kualitas kode}',
    '',
    '### Verdict Rationale',
    '{alasan verdict di atas}',
    '',
    '### For Developer',
    '{catatan untuk developer, kalau relevan}',
    '```',
    'Verdict HARUS persis salah satu dari tiga nilai di atas (APPROVE / CHANGES REQUESTED /',
    'DEFER) — jangan pakai nilai lain (mis. NEEDS_HUMAN dipakai untuk siklus retry pipeline',
    'otomatis, bukan untuk mode INITIAL single-run ini).',
  ].join('\n');
}

function buildReviewerPrompt(ticketKey: string, mode: PrReviewJobPayload['mode'], commentContext: PrReviewCommentContext[]): string {
  return mode === 'initial' ? buildInitialReviewPrompt(ticketKey, mode) : buildFixReviewPrompt(ticketKey, mode, commentContext);
}

function replyBody(entry: FixReviewLogEntry): string {
  return entry.note ? `${entry.status} — ${entry.note}` : entry.status;
}

function buildInitialReviewBody(verdict: InitialReviewVerdict, raw: string): string {
  return [`Verdict: ${verdictLabel(verdict)}`, '', raw.trim()].join('\n');
}

// Self-review 422 fallback — per requirements.md "Keputusan Final" (2026-09-04):
// auto-fallback to event COMMENT, real Verdict stated explicitly on the first
// line of the body. No interactive choice (unlike review-command.js) — there's
// no human to ask in a webhook context.
function buildSelfReviewFallbackBody(verdict: InitialReviewVerdict, raw: string): string {
  const event = VERDICT_TO_EVENT[verdict];
  return [
    `Verdict: ${verdictLabel(verdict)} (posted as COMMENT — GitHub does not allow self-review ${
      event === 'APPROVE' ? 'approval' : 'rejection'
    })`,
    '',
    raw.trim(),
  ].join('\n');
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
    const { gitService, workspaceManager, agentRunner, notifier } = this.deps;

    // Validate before creating a workspace — a throw here must not leave an
    // orphaned workspace dir behind (this line runs outside the try/finally).
    const ticketKey = extractTicketKey(job.prHeadBranch);
    const [owner, repo] = job.repoFullName.split('/');

    // CAF-WSMODE-01: explicit purpose — PR-review jobs stay ephemeral always,
    // regardless of config.workspace.mode (see WorkspacePurpose doc comment).
    const workspacePath = await workspaceManager.createWorkspace(undefined, 'pr-review');
    const repoPath = `${workspacePath}/repo`;

    logger.info('PR review job started', undefined, {
      jobId: job.jobId,
      prNumber: job.prNumber,
      ticketKey,
      mode: job.mode,
    });

    void notifier?.notifyPrReviewStarted({
      jobId: job.jobId,
      ticketKey,
      prNumber: job.prNumber,
      repoFullName: job.repoFullName,
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

      // Mode `initial` now runs the real INITIAL (Verdict-producing) contract —
      // a PR Review object via pulls/{number}/reviews, not a fix-review-log
      // reply cycle. `scoped`/`global` are untouched (CAF-ORCH-PRREVIEW-03
      // non-negotiable) — same readFixReviewLog + reply + postIssueComment
      // path as before this change.
      const entryCount =
        job.mode === 'initial'
          ? await this.postInitialReview(repoPath, ticketKey, owner, repo, job)
          : await this.postFixReview(repoPath, ticketKey, owner, repo, job);

      logger.info('PR review job completed', undefined, {
        jobId: job.jobId,
        ticketKey,
        prNumber: job.prNumber,
        entryCount,
      });

      void notifier?.notifyPrReviewCompleted({
        jobId: job.jobId,
        ticketKey,
        prNumber: job.prNumber,
        repoFullName: job.repoFullName,
        mode: job.mode,
        entryCount,
      });
    } catch (err) {
      void notifier?.notifyPrReviewFailed({
        jobId: job.jobId,
        ticketKey,
        prNumber: job.prNumber,
        repoFullName: job.repoFullName,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      await workspaceManager.cleanupWorkspace(workspacePath, undefined, 'pr-review');
    }
  }

  // Unchanged from before CAF-ORCH-PRREVIEW-03 — moved into its own method
  // only to make room for the mode `initial` branch in execute(). Reply +
  // summary-comment behavior for mode `scoped`/`global` is byte-for-byte
  // identical to before this change.
  private async postFixReview(
    repoPath: string,
    ticketKey: string,
    owner: string,
    repo: string,
    job: PrReviewJobPayload,
  ): Promise<number> {
    const { vcsClient } = this.deps;

    const fixReviewLog = await readFixReviewLog(repoPath, ticketKey);
    if (!fixReviewLog) {
      throw new Error('No fix-review-log.md produced');
    }

    for (const entry of fixReviewLog.entries) {
      if (entry.label !== 'INLINE') continue;
      const commentId = Number(entry.commentRef);
      if (!Number.isFinite(commentId)) {
        logger.warn('fix-review-log entry has non-numeric commentRef, skipping reply', undefined, {
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

    return fixReviewLog.entries.length;
  }

  // Real INITIAL mode (CAF-ORCH-PRREVIEW-03) — posts an official GitHub PR
  // Review object (pulls/{number}/reviews), equivalent to caf-initiator's
  // `/caf-review`. An unrecognized/missing Verdict propagates
  // UnrecognizedVerdictError up through execute()'s catch (→ notifyPrReviewFailed
  // + rethrow, same STOP-on-crash path as any other agent contract violation
  // in this file) — deliberately NOT the same handling as the self-review 422
  // case below, per the ticket's non-negotiable: don't unify the two.
  private async postInitialReview(
    repoPath: string,
    ticketKey: string,
    owner: string,
    repo: string,
    job: PrReviewJobPayload,
  ): Promise<number> {
    const { vcsClient } = this.deps;

    const report = await readInitialReviewReport(repoPath, ticketKey);
    if (!report) {
      throw new Error('No review-notes.md produced');
    }

    const event = VERDICT_TO_EVENT[report.verdict];
    const body = buildInitialReviewBody(report.verdict, report.raw);

    try {
      await vcsClient.createPullRequestReview({ owner, repo, prNumber: job.prNumber, event, body });
    } catch (err) {
      if (!(err instanceof SelfReviewRejectedError)) {
        throw err;
      }
      // STOP item, decided (requirements.md "Keputusan Final", 2026-09-04):
      // auto-fallback to COMMENT, real Verdict stated explicitly in the body —
      // no interactive choice, there's no human to ask in a webhook context.
      logger.info('Self-review rejected by GitHub (422), auto-falling back to COMMENT', undefined, {
        jobId: job.jobId,
        ticketKey,
        prNumber: job.prNumber,
        originalEvent: event,
        verdict: report.verdict,
      });
      await vcsClient.createPullRequestReview({
        owner,
        repo,
        prNumber: job.prNumber,
        event: 'COMMENT',
        body: buildSelfReviewFallbackBody(report.verdict, report.raw),
      });
    }

    return 1;
  }
}
