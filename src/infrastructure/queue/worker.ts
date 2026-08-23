import { Worker, type Job } from 'bullmq';
import type { JobRunner, JobPayload } from '../../domain/interfaces/queue.interface.js';
import { getRedisConnectionOptions } from './connection.js';
import { QUEUE_NAME } from './client.js';
import { logger } from '../logging/logger.js';
import { config } from '../../config/index.js';

// Agent pipeline runs (planner + frontend/backend agents) take minutes, unlike the
// quick API calls the old caf-orchestrator worker was tuned for. BullMQ's own
// stall detection must not fire mid-run, so lockDuration is set far above any
// expected job duration. Actual timeout enforcement happens in spawn-agent.service
// (CLAUDE_AGENT_TIMEOUT_MS, default 30 min) — see risk #1 in caf-orchestrator-plan.md.
// Set 5 min above that default so BullMQ doesn't flag the job as stalled while
// spawn-agent is still in its SIGTERM->SIGKILL escalation window.
const LOCK_DURATION_MS = 35 * 60_000;
const LOCK_RENEW_TIME_MS = 5 * 60_000;

// Running multiple Claude Code agent processes concurrently on one runner is
// expensive (CPU + API cost + contention); default to 1, override via config if needed.
const CONCURRENCY = config.queue.workerConcurrency;

export class QueueWorker {
  private readonly worker: Worker;
  private readonly jobStartTimes = new Map<string, bigint>();

  constructor(runner: JobRunner) {
    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        const id = job.id ?? 'unknown';
        this.jobStartTimes.set(id, process.hrtime.bigint());

        logger.info('Job dequeued', undefined, {
          jobId: id,
          name: job.name,
          enqueuedAt: job.timestamp,
          queueWaitMs: Date.now() - job.timestamp,
        });

        await runner({
          name: job.name,
          data: job.data as JobPayload,
          id,
        });
      },
      {
        connection: getRedisConnectionOptions(),
        concurrency: CONCURRENCY,
        lockDuration: LOCK_DURATION_MS,
        lockRenewTime: LOCK_RENEW_TIME_MS,
      },
    );

    this.worker.on('completed', (job: Job) => {
      const id = job.id ?? 'unknown';
      const start = this.jobStartTimes.get(id);
      const durationMs = start ? Math.round(Number(process.hrtime.bigint() - start) / 1e6) : -1;
      this.jobStartTimes.delete(id);

      logger.info('Job completed', undefined, { jobId: id, name: job.name, durationMs });
    });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      const id = job?.id ?? 'unknown';
      const start = this.jobStartTimes.get(id);
      const durationMs = start ? Math.round(Number(process.hrtime.bigint() - start) / 1e6) : -1;
      this.jobStartTimes.delete(id);

      logger.error('Job failed', err, {
        jobId: id,
        name: job?.name,
        attempts: job?.attemptsMade,
        durationMs,
      });
    });

    this.worker.on('error', (err: Error) => {
      logger.error('Worker error', err);
    });

    this.worker.on('stalled', (jobId: string) => {
      logger.warn('Job stalled', undefined, { jobId });
    });
  }

  start(): void {
    logger.info('Worker started', undefined, { queue: QUEUE_NAME, concurrency: CONCURRENCY });
  }

  async stop(): Promise<void> {
    await this.worker.close();
    logger.info('Worker stopped');
  }
}
