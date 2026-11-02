import type { Redis } from 'ioredis';

import { errors } from '../http/errors.js';

export type LimitRule = { limit: number; windowS: number };

/**
 * Fixed-window counters in Redis, shared by every API instance.
 * Used for business keys (per phone, per identifier) on top of the per-IP route limits.
 */
export class Limiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly scale = 1,
  ) {}

  /** Counts one hit; throws 429 once the window's limit is passed. */
  async hit(key: string, rule: LimitRule, message?: string) {
    const k = `${this.prefix}:rl:${key}`;
    const [[, count], [, ttl]] = (await this.redis.multi().incr(k).expire(k, rule.windowS, 'NX').ttl(k).exec()) as [[null, number], [null, number], [null, number]];
    if (count > rule.limit * this.scale) throw errors.tooMany(message, ttl > 0 ? ttl : rule.windowS);
  }

  async reset(key: string) {
    await this.redis.del(`${this.prefix}:rl:${key}`);
  }
}
