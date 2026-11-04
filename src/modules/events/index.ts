import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db, MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { AccountsApi } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { MediaApi, MediaUsage } from '../media/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { OrganizationsApi } from '../organizations/index.js';
import type { PaymentsApi } from '../payments/index.js';
import type { TicketingApi } from '../ticketing/index.js';
import { eventsCollections, eventsMigrations } from './events.collections.js';
import { registerEventsRoutes } from './events.routes.js';
import { EventsService } from './events.service.js';

export { eventsCollections, eventsMigrations };
/** The rules quoted in the terms of use (legal module). */
export { LATE_CANCEL_FEE, PUBLICATION_FEE } from './events.types.js';

export const EVENTS_SWEEP_QUEUE = 'events.sweep';

export type EventsApi = Pick<EventsService, 'promotable' | 'summaries'> & {
  registerRoutes(app: FastifyInstance, requireAdmin: preHandlerHookHandler): void;
  processors(): Record<string, () => Promise<unknown>>;
  schedules: { queue: string; everyMs: number }[];
  /** Tests and the seed. */
  service: EventsService;
};

/** Event pictures. The media module deletes a picture once none of these reference it. */
export const EVENTS_MEDIA_USAGE: MediaUsage[] = [{ collection: 'events', path: 'images.mediaId' }];

export function createEventsModule(d: {
  db: Db;
  mongo: MongoClient;
  clock: Clock;
  accounts: AccountsApi;
  organizations: OrganizationsApi;
  payments: PaymentsApi;
  ticketing: TicketingApi;
  media: MediaApi;
  limiter: Limiter;
  audit: AuditApi;
  notifications: NotificationsApi;
}): EventsApi {
  const service = new EventsService(d.db, d.mongo, d.clock, d.accounts, d.organizations, d.payments, d.ticketing, d.media, d.limiter, d.notifications);
  d.payments.registerPurpose('event_booking', service.bookingPayment);
  d.payments.registerPurpose('event_publication', service.publicationPayment);
  d.ticketing.registerKind('event_entry', service.ticketKind);
  return {
    promotable: (o, id) => service.promotable(o, id),
    summaries: (ids) => service.summaries(ids),
    registerRoutes: (app, requireAdmin) => registerEventsRoutes(app, { service, audit: d.audit, requireOrgRole: d.organizations.requireOrgRole, requireStudent: d.accounts.requireStudent, requireAdmin }),
    processors: () => ({ [EVENTS_SWEEP_QUEUE]: () => service.sweep() }),
    schedules: [{ queue: EVENTS_SWEEP_QUEUE, everyMs: 5 * 60_000 }],
    service,
  };
}
