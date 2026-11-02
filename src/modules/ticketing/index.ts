import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { toObjectId } from '../../platform/http/schemas.js';
import type { RealtimeHub } from '../../platform/realtime/hub.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { TokenService } from '../../platform/security/tokens.js';
import type { AccountsApi } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { OrganizationsApi } from '../organizations/index.js';
import type { PaymentsApi } from '../payments/index.js';
import { ticketingCollections, ticketingMigrations } from './ticketing.collections.js';
import { registerTicketingRoutes } from './ticketing.routes.js';
import { TicketingService } from './ticketing.service.js';

export { ticketingCollections, ticketingMigrations };
export { EventSummaryView, TicketView } from './ticketing.routes.js';
export type { AdmissionCheck, CancellationQuote, EventSummary, TicketDoc, TicketKindHandler } from './ticketing.types.js';

export const TICKET_TRANSFERS_SWEEP_QUEUE = 'tickets.transfers-sweep';

/** What modules owning events use: issue tickets, cancel them all, read counts. They never touch the collections. */
export type TicketingApi = Pick<
  TicketingService,
  'registerKind' | 'issue' | 'hasActiveTicket' | 'isTravelling' | 'offerToPassenger' | 'findById' | 'activeTickets' | 'counts' | 'revenue' | 'cancelAllForEvent' | 'admittedTicketIds'
> & {
  /** For offline scanning: the key QR codes are verified with. */
  verificationKey(): ReturnType<TokenService['ticketKey']>;
  registerRoutes(app: FastifyInstance): void;
  processors(): Record<string, () => Promise<unknown>>;
  schedules: { queue: string; everyMs: number }[];
};

export function createTicketingModule(d: {
  db: Db;
  mongo: MongoClient;
  clock: Clock;
  tokens: TokenService;
  accounts: AccountsApi;
  organizations: OrganizationsApi;
  payments: PaymentsApi;
  hub: RealtimeHub;
  limiter: Limiter;
  audit: AuditApi;
  notifications: NotificationsApi;
}): TicketingApi {
  const service = new TicketingService(d.db, d.mongo, d.clock, d.tokens, d.accounts, d.organizations, d.payments, d.hub, d.limiter, d.notifications);
  // Live boarding on the organizer's phones: members of the organization running the event only.
  d.hub.authorize('event', async (userId, id) => /^[a-f0-9]{24}$/.test(id) && service.canFollowEvent(toObjectId(userId), toObjectId(id)));
  return {
    registerKind: (k, h) => service.registerKind(k, h),
    issue: (i, s) => service.issue(i, s),
    hasActiveTicket: (e, u, s) => service.hasActiveTicket(e, u, s),
    isTravelling: (e, p, o) => service.isTravelling(e, p, o),
    offerToPassenger: (t) => service.offerToPassenger(t),
    findById: (id, s) => service.findById(id, s),
    activeTickets: (e) => service.activeTickets(e),
    counts: (ids) => service.counts(ids),
    revenue: (e, s) => service.revenue(e, s),
    cancelAllForEvent: (e, r, s) => service.cancelAllForEvent(e, r, s),
    admittedTicketIds: (e) => service.admittedTicketIds(e),
    verificationKey: () => d.tokens.ticketKey(),
    registerRoutes: (app) => registerTicketingRoutes(app, { service, audit: d.audit, requireOrgRole: d.organizations.requireOrgRole }),
    processors: () => ({ [TICKET_TRANSFERS_SWEEP_QUEUE]: () => service.expireTransfers() }),
    schedules: [{ queue: TICKET_TRANSFERS_SWEEP_QUEUE, everyMs: 5 * 60_000 }],
  };
}
