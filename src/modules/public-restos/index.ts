import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db, ObjectId } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import type { AlertsApi } from '../alerts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { publicRestosCollections, publicRestosMigrations } from './public-restos.collections.js';
import { registerPublicRestosRoutes } from './public-restos.routes.js';
import { PublicRestosService } from './public-restos.service.js';

export { publicRestosCollections, publicRestosMigrations };

export type PublicRestosApi = {
  /** requireStaff: menu publishers (each on their restaurants, `restosOf`); requireAdmin: creating and editing the restaurants. */
  registerRoutes(app: FastifyInstance, guards: { requireStaff: preHandlerHookHandler; requireAdmin: preHandlerHookHandler; restosOf: (userId: ObjectId) => Promise<ObjectId[] | null> }): void;
  /** Tests and the seed. */
  service: PublicRestosService;
};

export function createPublicRestosModule(d: { db: Db; clock: Clock; audit: AuditApi; alerts: AlertsApi; notifications: NotificationsApi }): PublicRestosApi {
  const service = new PublicRestosService(d.db, d.clock, d.alerts, d.notifications);
  return {
    registerRoutes: (app, guards) => registerPublicRestosRoutes(app, { service, audit: d.audit, ...guards }),
    service,
  };
}
