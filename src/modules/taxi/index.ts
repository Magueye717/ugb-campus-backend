import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';

import type { Config } from '../../config/env.js';
import type { Clock } from '../../platform/clock.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { AccountsApi } from '../accounts/index.js';
import type { MessagingApi } from '../messaging/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { PaymentsApi } from '../payments/index.js';
import { taxiCollections } from './taxi.collections.js';
import { registerTaxiRoutes } from './taxi.routes.js';
import { TaxiService } from './taxi.service.js';

export { taxiCollections };

export const TAXI_SWEEP_QUEUE = 'taxi.sweep';

export type TaxiApi = {
  registerRoutes(app: FastifyInstance): void;
  processors(): Record<string, () => Promise<unknown>>;
  schedules: { queue: string; everyMs: number }[];
  /** Tests and the seed. */
  service: TaxiService;
};

export function createTaxiModule(d: { db: Db; mongo: MongoClient; clock: Clock; config: Config; accounts: AccountsApi; payments: PaymentsApi; messaging: MessagingApi; limiter: Limiter; notifications: NotificationsApi }): TaxiApi {
  const service = new TaxiService(d.db, d.mongo, d.clock, d.config, d.accounts, d.payments, d.messaging, d.limiter, d.notifications);
  d.payments.registerPurpose('taxi_seat', service.seatPayment);
  return {
    registerRoutes: (app) => registerTaxiRoutes(app, { service, requireStudent: d.accounts.requireStudent }),
    processors: () => ({ [TAXI_SWEEP_QUEUE]: () => service.sweep() }),
    schedules: [{ queue: TAXI_SWEEP_QUEUE, everyMs: 60_000 }],
    service,
  };
}
