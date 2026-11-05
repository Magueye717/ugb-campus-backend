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
import { commerceCollections, commerceMigrations } from './commerce.collections.js';
import { registerCommerceRoutes } from './commerce.routes.js';
import { CommerceService } from './commerce.service.js';

export { commerceCollections, commerceMigrations };

export const COMMERCE_SWEEP_QUEUE = 'commerce.sweep';

export type CommerceApi = {
  registerRoutes(app: FastifyInstance, requireAdmin: preHandlerHookHandler): void;
  processors(): Record<string, () => Promise<unknown>>;
  schedules: { queue: string; everyMs: number }[];
  /** Tests and the seed. */
  service: CommerceService;
};

/** Restaurant and shop photos, product photos. The media module deletes a picture once none of these reference it. */
export const COMMERCE_MEDIA_USAGE: MediaUsage[] = [
  { collection: 'businesses', path: 'photo.mediaId' },
  { collection: 'catalogItems', path: 'photos.mediaId' },
];

export function createCommerceModule(d: {
  db: Db;
  mongo: MongoClient;
  clock: Clock;
  accounts: AccountsApi;
  organizations: OrganizationsApi;
  payments: PaymentsApi;
  media: MediaApi;
  notifications: NotificationsApi;
  limiter: Limiter;
  audit: AuditApi;
}): CommerceApi {
  const service = new CommerceService(d.db, d.mongo, d.clock, d.accounts, d.organizations, d.payments, d.media, d.notifications, d.limiter);
  d.payments.registerPurpose('commerce_order', service.orderPayment);
  return {
    registerRoutes: (app, requireAdmin) => registerCommerceRoutes(app, { service, audit: d.audit, requireOrgRole: d.organizations.requireOrgRole, roleIn: (o, u, r, sp) => d.organizations.roleIn(o, u, r, sp), requireAdmin,
      editsKind: (u, k) => d.accounts.hasPlatformRole(u, k === 'restaurant' ? 'restaurant_editor' : 'shop_editor'),
    }),
    processors: () => ({ [COMMERCE_SWEEP_QUEUE]: () => service.sweep() }),
    schedules: [{ queue: COMMERCE_SWEEP_QUEUE, everyMs: 15 * 60_000 }],
    service,
  };
}
