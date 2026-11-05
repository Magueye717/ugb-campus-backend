import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { toObjectId } from '../../platform/http/schemas.js';
import type { AccountsApi } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { MediaApi, MediaUsage } from '../media/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { alertsCollections, alertsMigrations } from './alerts.collections.js';
import { registerAlertsRoutes } from './alerts.routes.js';
import { AlertsService } from './alerts.service.js';

export { alertsCollections, alertsMigrations };

export const ALERTS_SWEEP_QUEUE = 'alerts.sweep';

/** Announcements' pictures and PDFs. The media module deletes a file once none of these reference it. */
export const ALERTS_MEDIA_USAGE: MediaUsage[] = [
  { collection: 'alerts', path: 'image.mediaId' },
  { collection: 'alerts', path: 'attachment.mediaId' },
];

/** Features raise and clear their own alerts (a dish sold out); the communication and academic teams post the others. */
export type AlertsApi = Pick<AlertsService, 'raise' | 'clear'> & {
  registerRoutes(app: FastifyInstance, requireEditor: preHandlerHookHandler): void;
  processors(): Record<string, () => Promise<unknown>>;
  schedules: { queue: string; everyMs: number }[];
  /** Tests and the seed. */
  service: AlertsService;
};

export function createAlertsModule(d: { db: Db; clock: Clock; audit: AuditApi; notifications: NotificationsApi; accounts: AccountsApi; media: MediaApi }): AlertsApi {
  const service = new AlertsService(d.db, d.clock, d.notifications, d.media);
  const rolesOf = async (userId: string) => (await d.accounts.findById(toObjectId(userId)))?.platformRoles ?? [];
  const audienceOf = (userId: string) => d.accounts.audienceOf(toObjectId(userId));
  return {
    raise: (k, i) => service.raise(k, i),
    clear: (k) => service.clear(k),
    registerRoutes: (app, requireEditor) => registerAlertsRoutes(app, { service, audit: d.audit, requireEditor, rolesOf, audienceOf, media: d.media }),
    // Scheduled alerts going online: their push leaves then.
    processors: () => ({ [ALERTS_SWEEP_QUEUE]: () => service.sweep() }),
    schedules: [{ queue: ALERTS_SWEEP_QUEUE, everyMs: 60_000 }],
    service,
  };
}
