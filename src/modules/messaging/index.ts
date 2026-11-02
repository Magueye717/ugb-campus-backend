import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { toObjectId } from '../../platform/http/schemas.js';
import type { RealtimeHub } from '../../platform/realtime/hub.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { AuditApi } from '../audit/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { messagingCollections } from './messaging.collections.js';
import { registerMessagingRoutes } from './messaging.routes.js';
import { MessagingService } from './messaging.service.js';

export { messagingCollections };
export type { ConversationMember, ConversationType, MemberIdentity } from './messaging.types.js';
export type { ConversationSync } from './messaging.service.js';

/** What features with conversations use: they own membership and system lines, messaging does the rest. */
export type MessagingApi = Pick<MessagingService, 'sync' | 'postSystem' | 'idsFor'> & {
  registerRoutes(app: FastifyInstance, requireAdmin: preHandlerHookHandler): void;
};

export function createMessagingModule(d: { db: Db; clock: Clock; hub: RealtimeHub; limiter: Limiter; audit: AuditApi; notifications: NotificationsApi }): MessagingApi {
  const service = new MessagingService(d.db, d.clock, d.hub, d.limiter, d.notifications);
  // Only members follow a conversation in real time, checked again whenever its membership changes.
  d.hub.authorize('conversation', async (userId, id) => /^[a-f0-9]{24}$/.test(id) && service.isMember(toObjectId(id), toObjectId(userId)));
  return {
    sync: (t, r, s, session) => service.sync(t, r, s, session),
    postSystem: (t, r, b, session) => service.postSystem(t, r, b, session),
    idsFor: (t, refs) => service.idsFor(t, refs),
    registerRoutes: (app, requireAdmin) => registerMessagingRoutes(app, { service, audit: d.audit, requireAdmin }),
  };
}
