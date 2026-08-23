import { logger } from './infrastructure/logging/logger.js';
import { QueueWorker } from './infrastructure/queue/worker.js';
import { RunAgentPipelineUseCase } from './application/use-cases/run-agent-pipeline.use-case.js';
import { RunPrReviewUseCase } from './application/use-cases/run-pr-review.use-case.js';
import { GitService } from './infrastructure/git/git.service.js';
import { WorkspaceManager } from './infrastructure/git/workspace.manager.js';
import { spawnAgentService } from './infrastructure/agent/spawn-agent.service.js';
import { linearService } from './infrastructure/linear/linear.service.js';
import { githubService } from './infrastructure/vcs/github.service.js';
import { TelegramNotifier } from './infrastructure/notifications/telegram.notifier.js';
import { config } from './config/index.js';
import type { ExistingJobPayload, PrReviewJobPayload } from './domain/interfaces/queue.interface.js';

const notifier =
  config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID
    ? new TelegramNotifier(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID)
    : undefined;

const agentPipelineUseCase = new RunAgentPipelineUseCase({
  gitService: new GitService(),
  workspaceManager: new WorkspaceManager(),
  agentRunner: spawnAgentService,
  linearClient: linearService,
  vcsClient: githubService,
  notifier,
});

const prReviewUseCase = new RunPrReviewUseCase({
  gitService: new GitService(),
  workspaceManager: new WorkspaceManager(),
  agentRunner: spawnAgentService,
  vcsClient: githubService,
});

const worker = new QueueWorker(async (job) => {
  switch (job.name) {
    case 'agent-pipeline':
      await agentPipelineUseCase.execute(job.data as ExistingJobPayload);
      return;
    case 'pr-review':
      await prReviewUseCase.execute(job.data as PrReviewJobPayload);
      return;
    default:
      throw new Error(`Unknown job name: ${job.name}`);
  }
});

worker.start();

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down worker`);
  try {
    await worker.stop();
    process.exit(0);
  } catch (err) {
    logger.fatal('Worker shutdown error', err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
