import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db, MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { AccountsApi } from '../accounts/index.js';
import type { AlertsApi } from '../alerts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { MediaApi, MediaUsage } from '../media/index.js';
import type { MessagingApi } from '../messaging/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { lostCollections } from './lost.collections.js';
import type { CardReader } from './lost.ocr.js';
import { registerLostRoutes } from './lost.routes.js';
import { LostService } from './lost.service.js';

export { lostCollections };
export { TesseractCardReader, parseCard, type CardReader } from './lost.ocr.js';

export type LostApi = {
  registerRoutes(app: FastifyInstance, requireOffice: preHandlerHookHandler): void;
  close(): Promise<void>;
  /** Tests and the seed. */
  service: LostService;
};

/** Photos of declared objects. The media module deletes a picture once none of these reference it. */
export const LOST_MEDIA_USAGE: MediaUsage[] = [{ collection: 'lostItems', path: 'photo.mediaId' }];

export function createLostModule(d: {
  db: Db;
  mongo: MongoClient;
  clock: Clock;
  accounts: AccountsApi;
  messaging: MessagingApi;
  notifications: NotificationsApi;
  alerts: AlertsApi;
  media: MediaApi;
  limiter: Limiter;
  audit: AuditApi;
  reader: CardReader;
}): LostApi {
  const service = new LostService(d.db, d.mongo, d.clock, d.accounts, d.messaging, d.notifications, d.alerts, d.media, d.limiter, d.reader);
  return {
    registerRoutes: (app, requireOffice) => registerLostRoutes(app, { service, audit: d.audit, requireStudent: d.accounts.requireStudent, requireOffice }),
    close: () => d.reader.close(),
    service,
  };
}
