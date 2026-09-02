import type {
  INotifier,
  PipelineNotification,
  PipelineFailureNotification,
  PipelineNeedsHumanNotification,
  PipelineStartedNotification,
  AgentSkippedNotification,
  AgentStartedNotification,
  PrReviewStartedNotification,
  PrReviewCompletedNotification,
  PrReviewFailedNotification,
} from '../../domain/interfaces/notifier.interface.js';
import { logger } from '../logging/logger.js';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class TelegramNotifier implements INotifier {
  private readonly apiUrl: string;

  // notifyAgentStarted fires on every implementation-agent retry loop (QA/reviewer
  // retries re-run the same agent) — dedupe per jobId+agentName so a retried agent
  // doesn't re-announce itself and flood the chat. Cleared when the job ends
  // (notifyPipelineComplete/notifyPipelineFailed) so the set can't grow unbounded.
  private readonly announcedAgents = new Set<string>();

  constructor(
    botToken: string,
    private readonly chatId: string,
  ) {
    this.apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  }

  async notifyPipelineStarted(info: PipelineStartedNotification): Promise<void> {
    const lines = [
      `🤖 CAF Pipeline dimulai`,
      `Ticket: ${esc(info.ticketKey)} — ${esc(info.ticketTitle)}`,
      `Job ID: ${esc(info.jobId)}`,
      ``,
      `Kalau ini salah ticket, cancel manual sekarang di BullMQ dashboard/CLI sebelum agent mulai jalan.`,
    ];
    await this.send(lines.join('\n'));
  }

  async notifyPipelineComplete(info: PipelineNotification): Promise<void> {
    this.clearAnnouncedAgents(info.jobId);
    const duration = (info.durationMs / 1000).toFixed(1);
    const lines = [
      `✅ <b>Agent Pipeline Complete</b>`,
      ``,
      `🎫 ${esc(info.ticketKey)}`,
      `🌿 ${esc(info.branch)}`,
      `⏱ ${duration}s`,
    ];
    await this.send(lines.join('\n'));
  }

  async notifyPipelineFailed(info: PipelineFailureNotification): Promise<void> {
    this.clearAnnouncedAgents(info.jobId);
    const lines = [
      `❌ <b>Agent Pipeline Failed</b>`,
      ``,
      `🎫 ${esc(info.ticketKey)}`,
      `⚠️ ${esc(info.errorMessage)}`,
    ];
    await this.send(lines.join('\n'));
  }

  async notifyAgentStarted(info: AgentStartedNotification): Promise<void> {
    const key = `${info.jobId}:${info.agentName}`;
    if (this.announcedAgents.has(key)) return;
    this.announcedAgents.add(key);

    const lines = [
      `🚧 <b>Agent Working</b>`,
      ``,
      `🎫 ${esc(info.ticketKey)}`,
      `🤖 Agent: ${esc(info.agentName)}`,
    ];
    await this.send(lines.join('\n'));
  }

  async notifyPipelineNeedsHuman(info: PipelineNeedsHumanNotification): Promise<void> {
    this.clearAnnouncedAgents(info.jobId);
    const lines = [
      `🟡 <b>Pipeline Stopped — Needs Human Review</b>`,
      ``,
      `🎫 ${esc(info.ticketKey)}`,
      `📝 ${esc(info.reason)}`,
      ``,
      `Lihat komentar di ticket/issue untuk detail lengkap.`,
    ];
    await this.send(lines.join('\n'));
  }

  async notifyAgentSkipped(info: AgentSkippedNotification): Promise<void> {
    const lines = [
      `⏭️ <b>Agent Skipped</b>`,
      ``,
      `🎫 ${esc(info.ticketKey)}`,
      `🤖 Agent: ${esc(info.agentName)}`,
      `📝 Alasan: ${esc(info.reason)}`,
    ];
    await this.send(lines.join('\n'));
  }

  async notifyPrReviewStarted(info: PrReviewStartedNotification): Promise<void> {
    const lines = [
      `🔎 <b>PR Review Started</b>`,
      ``,
      `🎫 ${esc(info.ticketKey)}`,
      `🔀 ${esc(info.repoFullName)}#${info.prNumber}`,
      `Mode: ${esc(info.mode)}`,
    ];
    await this.send(lines.join('\n'));
  }

  async notifyPrReviewCompleted(info: PrReviewCompletedNotification): Promise<void> {
    const lines = [
      `✅ <b>PR Review Completed</b>`,
      ``,
      `🎫 ${esc(info.ticketKey)}`,
      `🔀 ${esc(info.repoFullName)}#${info.prNumber}`,
      `Mode: ${esc(info.mode)}`,
      `📋 ${info.entryCount} entri diproses`,
    ];
    await this.send(lines.join('\n'));
  }

  async notifyPrReviewFailed(info: PrReviewFailedNotification): Promise<void> {
    const lines = [
      `❌ <b>PR Review Failed</b>`,
      ``,
      `🎫 ${esc(info.ticketKey)}`,
      `🔀 ${esc(info.repoFullName)}#${info.prNumber}`,
      `⚠️ ${esc(info.errorMessage)}`,
    ];
    await this.send(lines.join('\n'));
  }

  private clearAnnouncedAgents(jobId: string): void {
    for (const key of this.announcedAgents) {
      if (key.startsWith(`${jobId}:`)) this.announcedAgents.delete(key);
    }
  }

  private async send(text: string): Promise<void> {
    try {
      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML' }),
      });
      if (!res.ok) {
        const body = await res.text();
        logger.warn('Telegram notification failed', undefined, { status: res.status, body });
      }
    } catch (err) {
      logger.warn('Telegram notification error', undefined, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
