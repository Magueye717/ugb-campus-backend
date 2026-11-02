import { Queue, Worker, type ConnectionOptions, type Job, type JobsOptions, type Processor } from 'bullmq';

/** Retries with exponential backoff; completed jobs are dropped, failed ones kept a week for inspection. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password || undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

/** One place that knows the queue names, their prefix and default options. */
export class Queues {
  private readonly queues = new Map<string, Queue>();

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly prefix: string,
  ) {}

  get(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, prefix: `${this.prefix}:bull`, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, q);
    }
    return q;
  }

  /** `jobId` makes enqueueing idempotent: the same id twice is one job. */
  add<T>(name: string, data: T, opts: JobsOptions & { jobId?: string } = {}) {
    return this.get(name).add(name, data, opts);
  }

  worker<T>(name: string, processor: Processor<T>, concurrency = 5): Worker<T> {
    return new Worker<T>(name, processor as (job: Job<T>) => Promise<unknown>, {
      connection: this.connection,
      prefix: `${this.prefix}:bull`,
      concurrency,
    });
  }

  async close() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
