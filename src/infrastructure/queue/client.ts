import { Queue } from 'bullmq';
import type { IQueue } from '../../domain/interfaces/queue.interface.js';
import { config } from '../../config/index.js';
import { getRedisConnectionOptions } from './connection.js';
import { logger } from '../logging/logger.js';

export const QUEUE_NAME = 'agent-pipeline';

const defaultJobOptions = {
  removeOnComplete: {
    age: config.queue.jobTtlSeconds,
    count: config.queue.maxJobsRetained,
  },
  removeOnFail: {
    age: config.queue.jobTtlSeconds,
    count: config.queue.maxJobsRetained,
  },
  // Full-retry v1: on a failed attempt (including a killed agent process) the whole
  // job re-runs from clone. No step-resume state is persisted (see risk #2 in
  // caf-orchestrator-plan.md).
  attempts: config.queue.jobAttempts,
  backoff: { type: 'exponential' as const, delay: config.queue.backoffDelayMs },
};

class AgentPipelineQueue implements IQueue {
  readonly queue: Queue;

  constructor() {
    this.queue = new Queue(QUEUE_NAME, {
      connection: getRedisConnectionOptions(),
      defaultJobOptions,
    });

    this.queue.on('error', (err: Error) => {
      logger.error('Queue error', err);
    });
  }

  async addJob(name: string, data: Record<string, unknown>): Promise<string> {
    const job = await this.queue.add(name, data);
    const id = job.id ?? 'unknown';
    logger.info('Job enqueued', undefined, { jobId: id, name });
    return id;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

const agentPipelineQueue = new AgentPipelineQueue();

export const pipelineQueue: IQueue = agentPipelineQueue;
// Raw bullmq Queue, for infra-only consumers that need direct BullMQ access
// (e.g. Bull Board's BullMQAdapter) — bypasses the IQueue port on purpose,
// since that port is deliberately BullMQ-agnostic.
export const rawPipelineQueue: Queue = agentPipelineQueue.queue;
