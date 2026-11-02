import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import type { RealtimeHub } from '../../platform/realtime/hub.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { AccountsApi } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { OrganizationsApi } from '../organizations/index.js';
import type { PaymentsApi } from '../payments/index.js';
import type { TicketingApi } from '../ticketing/index.js';
import { caravansCollections, caravansMigrations } from './caravans.collections.js';
import { registerCaravansRoutes } from './caravans.routes.js';
import { CaravansService } from './caravans.service.js';

export { caravansCollections, caravansMigrations };

export const CARAVANS_SWEEP_QUEUE = 'caravans.sweep';

export type CaravansApi = {
  registerRoutes(app: FastifyInstance): void;
  processors(): Record<string, () => Promise<unknown>>;
  schedules: { queue: string; everyMs: number }[];
  /** Tests and the seed. */
  service: CaravansService;
};

export function createCaravansModule(d: {
  db: Db;
  mongo: MongoClient;
  clock: Clock;
  accounts: AccountsApi;
  organizations: OrganizationsApi;
  payments: PaymentsApi;
  ticketing: TicketingApi;
  hub: RealtimeHub;
  limiter: Limiter;
  audit: AuditApi;
  notifications: NotificationsApi;
}): CaravansApi {
  const service = new CaravansService(d.db, d.mongo, d.clock, d.accounts, d.organizations, d.payments, d.ticketing, d.hub, d.limiter, d.notifications);
  d.payments.registerPurpose('caravan_booking', service.bookingPayment);
  d.ticketing.registerKind('caravan_seat', service.ticketKind);
  return {
    registerRoutes: (app) => registerCaravansRoutes(app, { service, audit: d.audit, requireStudent: d.accounts.requireStudent, requireOrgRole: d.organizations.requireOrgRole }),
    processors: () => ({ [CARAVANS_SWEEP_QUEUE]: () => service.sweep() }),
    schedules: [{ queue: CARAVANS_SWEEP_QUEUE, everyMs: 60_000 }],
    service,
  };
}
