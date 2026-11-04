import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import type { NotificationsApi } from '../notifications/index.js';
import { ratingsCollections } from './ratings.collections.js';
import { registerRatingsRoutes } from './ratings.routes.js';
import { RatingsService, type RatingTargets } from './ratings.service.js';

export { ratingsCollections };

export const RATINGS_SWEEP_QUEUE = 'ratings.sweep';

export type RatingsApi = {
  registerRoutes(app: FastifyInstance): void;
  processors(): Record<string, () => Promise<unknown>>;
  schedules: { queue: string; everyMs: number }[];
  /** Tests. */
  service: RatingsService;
};

export function createRatingsModule(d: { db: Db; clock: Clock; notifications: NotificationsApi; targets: RatingTargets }): RatingsApi {
  const service = new RatingsService(d.db, d.clock, d.notifications, d.targets);
  return {
    registerRoutes: (app) => registerRatingsRoutes(app, { service }),
    processors: () => ({ [RATINGS_SWEEP_QUEUE]: () => service.sweep() }),
    schedules: [{ queue: RATINGS_SWEEP_QUEUE, everyMs: 5 * 60_000 }],
    service,
  };
}
