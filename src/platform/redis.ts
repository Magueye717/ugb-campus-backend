import { Redis } from 'ioredis';

/** Commands (rate limits, caches, denylist). BullMQ gets its own connections (see queue/). */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
}
