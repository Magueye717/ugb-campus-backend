import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db, MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { AuditApi } from '../audit/index.js';
import type { EventsApi } from '../events/index.js';
import type { MediaApi, MediaUsage } from '../media/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { OrganizationsApi } from '../organizations/index.js';
import type { PaymentsApi } from '../payments/index.js';
import { bannersCollections } from './banners.collections.js';
import { registerBannersRoutes } from './banners.routes.js';
import { BannersService } from './banners.service.js';

export { bannersCollections };

export type BannersApi = {
  registerRoutes(app: FastifyInstance, guards: { requireEditor: preHandlerHookHandler; requireAdmin: preHandlerHookHandler }): void;
  /** Tests and the seed. */
  service: BannersService;
};

/** Banner pictures (an event's banner may reuse the event's picture). The media module deletes a picture once none of these reference it. */
export const BANNERS_MEDIA_USAGE: MediaUsage[] = [{ collection: 'banners', path: 'image.mediaId' }];

export function createBannersModule(d: {
  db: Db;
  mongo: MongoClient;
  clock: Clock;
  payments: PaymentsApi;
  media: MediaApi;
  events: EventsApi;
  organizations: OrganizationsApi;
  limiter: Limiter;
  audit: AuditApi;
  notifications: NotificationsApi;
}): BannersApi {
  const service = new BannersService(d.db, d.mongo, d.clock, d.payments, d.media, d.events, d.organizations, d.limiter, d.notifications);
  d.payments.registerPurpose('banner', service.bannerPayment);
  const checkoutOf = async (id: import('mongodb').ObjectId | null) => {
    const p = id ? await d.payments.findById(id) : null;
    return p && (p.status === 'created' || p.status === 'pending') ? { reference: p.reference, checkoutUrl: p.checkoutUrl } : null;
  };
  return {
    registerRoutes: (app, g) => registerBannersRoutes(app, { service, audit: d.audit, ...g, checkoutOf }),
    service,
  };
}
