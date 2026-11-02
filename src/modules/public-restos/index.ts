import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import type { AlertsApi } from '../alerts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { publicRestosCollections, publicRestosMigrations } from './public-restos.collections.js';
import { registerPublicRestosRoutes } from './public-restos.routes.js';
import { PublicRestosService } from './public-restos.service.js';

export { publicRestosCollections, publicRestosMigrations };

export type PublicRestosApi = {
  registerRoutes(app: FastifyInstance, requireStaff: preHandlerHookHandler): void;
  /** Tests and the seed. */
  service: PublicRestosService;
};

export function createPublicRestosModule(d: { db: Db; clock: Clock; audit: AuditApi; alerts: AlertsApi; notifications: NotificationsApi }): PublicRestosApi {
  const service = new PublicRestosService(d.db, d.clock, d.alerts, d.notifications);
  return {
    registerRoutes: (app, requireStaff) => registerPublicRestosRoutes(app, { service, audit: d.audit, requireStaff }),
    service,
  };
}
