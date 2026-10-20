import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { PipelineRunRepository } from '../../../infrastructure/db/pipeline-run.repository.js';
import { toApiShape, type PipelineRunApiShape } from '../../../infrastructure/db/pipeline-run-shape.js';
import { normalizeRun } from '../../../presentation/web/agent-floor/event-normalizer.js';
import type { FailedJobInfo, HealthInfo, ITuiDataSource, QueueCounts, RunDetailView } from '../../domain/interfaces/data-source.interface.js';
import type { TuiSettings } from '../../domain/models/settings.js';

const QUEUE_NAME = 'agent-pipeline';
const CHANNEL = 'caf:dashboard:events';

const IOREDIS_OPTIONS = { maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: true } as const;

/** Plain options (not an IORedis instance): bullmq bundles its own ioredis copy, whose types reject ours. */
function bullConnection(redisUrl: string) {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    maxRetriesPerRequest: null,
  };
}

export class TuiDataSource implements ITuiDataSource {
  private db: Database.Database | null = null;
  private queue: Queue | null = null;
  private redis: IORedis | null = null;
  private subscriber: IORedis | null = null;

  constructor(private readonly settings: TuiSettings) {}

  /** Read-only handle; null until the worker has created the file (first run). Retried on every call. */
  private openDb(): Database.Database | null {
    if (this.db) return this.db;
    if (!existsSync(this.settings.dbPath)) return null;
    try {
      this.db = new Database(this.settings.dbPath, { readonly: true, fileMustExist: true });
      return this.db;
    } catch {
      return null;
    }
  }

  private getRedis(): IORedis {
    if (!this.redis) {
      this.redis = new IORedis(this.settings.redisUrl, { ...IOREDIS_OPTIONS, maxRetriesPerRequest: 1 });
      this.redis.on('error', () => undefined); // surfaced through health(), never thrown into the UI
    }
    return this.redis;
  }

  private getQueue(): Queue {
    if (!this.queue) {
      this.queue = new Queue(QUEUE_NAME, { connection: bullConnection(this.settings.redisUrl) });
      this.queue.on('error', () => undefined);
    }
    return this.queue;
  }

  listRuns(limit = 200): PipelineRunApiShape[] {
    const db = this.openDb();
    if (!db) return [];
    try {
      const repo = new PipelineRunRepository(db);
      return repo.getPipelineRuns(undefined, { limit }).map((run) => toApiShape(run, repo.getEventsForRun(run.id)));
    } catch {
      return [];
    }
  }

  getRunDetail(runId: string): RunDetailView | undefined {
    const db = this.openDb();
    if (!db) return undefined;
    try {
      const detail = new PipelineRunRepository(db).getRunById(runId);
      if (!detail) return undefined;
      return {
        run: detail.run,
        api: toApiShape(detail.run, detail.events),
        events: detail.events,
        floor: normalizeRun(detail.run, detail.events, { retryLimits: this.settings.retryLimits }),
      };
    } catch {
      return undefined;
    }
  }

  async queueCounts(): Promise<QueueCounts | null> {
    try {
      const c = await this.getQueue().getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      return { waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0, completed: c.completed ?? 0 };
    } catch {
      return null;
    }
  }

  async failedJobs(limit = 50): Promise<FailedJobInfo[]> {
    try {
      const jobs = await this.getQueue().getJobs(['failed'], 0, limit - 1, false);
      return jobs.map((j) => ({
        id: String(j.id),
        name: j.name,
        attemptsMade: j.attemptsMade,
        failedReason: j.failedReason ?? '',
        finishedOn: j.finishedOn ?? null,
        ticket: typeof (j.data as { ticketKey?: unknown })?.ticketKey === 'string' ? (j.data as { ticketKey: string }).ticketKey : null,
      }));
    } catch {
      return [];
    }
  }

  async retryJob(jobId: string): Promise<boolean> {
    try {
      const job = await this.getQueue().getJob(jobId);
      if (!job) return false;
      await job.retry('failed');
      return true;
    } catch {
      return false;
    }
  }

  async health(): Promise<HealthInfo> {
    let redis: HealthInfo['redis'] = 'down';
    try {
      redis = (await this.getRedis().ping()) === 'PONG' ? 'up' : 'down';
    } catch {
      redis = 'down';
    }

    const db: HealthInfo['db'] = !existsSync(this.settings.dbPath) ? 'missing' : this.openDb() ? 'up' : 'down';

    let server: HealthInfo['server'] = 'down';
    try {
      const res = await fetch(`http://127.0.0.1:${this.settings.serverPort}/health`, { signal: AbortSignal.timeout(1500) });
      server = res.status === 200 || res.status === 503 ? 'up' : 'down';
    } catch {
      server = 'down';
    }
    return { redis, db, server };
  }

  async probe(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
      return res.status === 200 || res.status === 503;
    } catch {
      return false;
    }
  }

  subscribe(onNudge: () => void): () => void {
    const sub = new IORedis(this.settings.redisUrl, IOREDIS_OPTIONS);
    sub.on('error', () => undefined);
    sub.subscribe(CHANNEL).catch(() => undefined);
    sub.on('message', (channel: string) => {
      if (channel === CHANNEL) onNudge();
    });
    this.subscriber = sub;
    return () => {
      sub.disconnect();
      if (this.subscriber === sub) this.subscriber = null;
    };
  }

  async close(): Promise<void> {
    this.subscriber?.disconnect();
    this.redis?.disconnect();
    await this.queue?.close().catch(() => undefined);
    this.db?.close();
    this.db = null;
  }
}
