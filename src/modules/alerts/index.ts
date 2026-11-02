import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { toObjectId } from '../../platform/http/schemas.js';
import type { AccountsApi } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { alertsCollections, alertsMigrations } from './alerts.collections.js';
import { registerAlertsRoutes } from './alerts.routes.js';
import { AlertsService } from './alerts.service.js';

export { alertsCollections, alertsMigrations };

export const ALERTS_SWEEP_QUEUE = 'alerts.sweep';

/** Features raise and clear their own alerts (a dish sold out); the communication and academic teams post the others. */
export type AlertsApi = Pick<AlertsService, 'raise' | 'clear'> & {
  registerRoutes(app: FastifyInstance, requireEditor: preHandlerHookHandler): void;
  processors(): Record<string, () => Promise<unknown>>;
  schedules: { queue: string; everyMs: number }[];
  /** Tests and the seed. */
  service: AlertsService;
};

export function createAlertsModule(d: { db: Db; clock: Clock; audit: AuditApi; notifications: NotificationsApi; accounts: AccountsApi }): AlertsApi {
  const service = new AlertsService(d.db, d.clock, d.notifications);
  const rolesOf = async (userId: string) => (await d.accounts.findById(toObjectId(userId)))?.platformRoles ?? [];
  const audienceOf = (userId: string) => d.accounts.audienceOf(toObjectId(userId));
  return {
    raise: (k, i) => service.raise(k, i),
    clear: (k) => service.clear(k),
    registerRoutes: (app, requireEditor) => registerAlertsRoutes(app, { service, audit: d.audit, requireEditor, rolesOf, audienceOf }),
    // Scheduled alerts going online: their push leaves then.
    processors: () => ({ [ALERTS_SWEEP_QUEUE]: () => service.sweep() }),
    schedules: [{ queue: ALERTS_SWEEP_QUEUE, everyMs: 60_000 }],
    service,
  };
}
