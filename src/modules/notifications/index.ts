import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Job } from 'bullmq';
import type { FastifyBaseLogger, FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from 'mongodb';
import { Type } from 'typebox';

import type { Config } from '../../config/env.js';
import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import { ObjectIdString, PhoneInput, toObjectId } from '../../platform/http/schemas.js';
import type { Queues } from '../../platform/queue/queues.js';
import type { RealtimeHub } from '../../platform/realtime/hub.js';
import type { AccountsApi } from '../accounts/index.js';
import { notificationsCollections } from './notifications.collections.js';
import { notificationView, NotificationsService, PUSH_QUEUE } from './notifications.service.js';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_SCOPES, type PushJob } from './notifications.types.js';
import { ExpoPushSender, LogPushSender, type PushSender } from './push.js';

export { notificationsCollections };
export type { Broadcast, NewNotification } from './notifications.types.js';

/** What features use to tell people something happened. */
export type NotificationsApi = Pick<NotificationsService, 'notify' | 'broadcast'> & {
  registerRoutes(app: FastifyInstance, requireAdmin: preHandlerHookHandler): void;
  processors(log: FastifyBaseLogger): Record<string, (job: Job) => Promise<unknown>>;
  /** Tests: send a push job now with the given sender. */
  sendPush(job: PushJob, sender: PushSender): ReturnType<NotificationsService['sendPush']>;
};

const View = Type.Object({
  id: Type.String(),
  category: Type.String(),
  type: Type.String(),
  title: Type.String(),
  body: Type.String(),
  icon: Type.String(),
  tone: Type.String(),
  url: Type.Union([Type.String(), Type.Null()]),
  read: Type.Boolean(),
  createdAt: Type.String(),
});

export function createNotificationsModule(d: { db: Db; clock: Clock; hub: RealtimeHub; queues: Queues; accounts: AccountsApi; config: Config }): NotificationsApi {
  const service = new NotificationsService(d.db, d.clock, d.hub, d.queues, d.accounts);

  const registerRoutes = (root: FastifyInstance, requireAdmin: preHandlerHookHandler) => {
    const app = root.withTypeProvider<TypeBoxTypeProvider>();
    const me = (req: Parameters<typeof actorOf>[0]) => toObjectId(actorOf(req).userId);
    const tags = ['notifications'];

    app.put(
      '/me/push-tokens',
      {
        preHandler: requireAuth,
        schema: {
          tags,
          body: Type.Object({ token: Type.String({ pattern: '^Expo(nent)?PushToken\\[.+\\]$', maxLength: 200 }), platform: Type.Enum(['ios', 'android', 'web'] as const) }, { additionalProperties: false }),
        },
      },
      async (req, reply) => {
        await service.registerToken(me(req), req.body.token, req.body.platform);
        return reply.status(204).send();
      },
    );

    app.post(
      '/me/push-tokens/unregister',
      { preHandler: requireAuth, schema: { tags, body: Type.Object({ token: Type.String({ maxLength: 200 }) }, { additionalProperties: false }) } },
      async (req, reply) => {
        await service.unregisterToken(me(req), req.body.token);
        return reply.status(204).send();
      },
    );

    app.get(
      '/notifications',
      {
        preHandler: requireAuth,
        schema: {
          tags,
          querystring: Type.Object(
            {
              category: Type.Optional(Type.Enum(NOTIFICATION_CATEGORIES)),
              scope: Type.Optional(Type.Enum(NOTIFICATION_SCOPES, { description: '`orders`: a restaurant’s or shop’s space, only the orders it receives.' })),
              before: Type.Optional(ObjectIdString),
              limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            },
            { additionalProperties: false },
          ),
          response: { 200: Type.Object({ items: Type.Array(View), hasMore: Type.Boolean() }) },
        },
      },
      async (req) => {
        const { items, hasMore } = await service.list(me(req), { category: req.query.category, scope: req.query.scope, before: req.query.before ? toObjectId(req.query.before) : undefined, limit: req.query.limit });
        return { items: items.map(notificationView), hasMore };
      },
    );

    app.get(
      '/notifications/unread-count',
      { preHandler: requireAuth, schema: { tags, querystring: Type.Object({ scope: Type.Optional(Type.Enum(NOTIFICATION_SCOPES)) }, { additionalProperties: false }), response: { 200: Type.Object({ count: Type.Number() }) } } },
      async (req) => ({ count: await service.unreadCount(me(req), req.query.scope) }),
    );

    app.post(
      '/notifications/read',
      { preHandler: requireAuth, schema: { tags, body: Type.Object({ ids: Type.Optional(Type.Array(ObjectIdString, { maxItems: 100 })), all: Type.Optional(Type.Boolean()), scope: Type.Optional(Type.Enum(NOTIFICATION_SCOPES)) }, { additionalProperties: false }) } },
      async (req, reply) => {
        await service.markRead(me(req), req.body);
        return reply.status(204).send();
      },
    );

    // Back office: send a notification to one account (testing push on a phone, a message from the team).
    app.post(
      '/admin/notifications',
      {
        preHandler: [requireAuth, requireAdmin],
        schema: {
          tags: ['admin'],
          body: Type.Object(
            {
              phone: PhoneInput,
              title: Type.String({ minLength: 1, maxLength: 120 }),
              body: Type.String({ maxLength: 300 }),
              category: Type.Enum(NOTIFICATION_CATEGORIES),
              url: Type.Optional(Type.String({ maxLength: 200, pattern: '^/' })),
            },
            { additionalProperties: false },
          ),
        },
      },
      async (req, reply) => {
        const user = await d.accounts.findByPhone(d.accounts.phoneOrThrow(req.body.phone));
        if (!user) throw errors.notFound('Aucun compte sur ce numéro.');
        await service.notify([user._id], {
          type: 'admin.message', category: req.body.category, title: req.body.title, body: req.body.body, icon: 'megaphone-outline',
          url: req.body.url ?? '/notifications', dedupeKey: `admin:${req.id}`,
        });
        return reply.status(202).send({ queued: true });
      },
    );
  };

  return {
    notify: (u, n, s) => service.notify(u, n, s),
    broadcast: (b) => service.broadcast(b),
    sendPush: (job, sender) => service.sendPush(job, sender),
    registerRoutes,
    processors: (log) => {
      const sender: PushSender = d.config.PUSH_PROVIDER === 'expo' ? new ExpoPushSender(d.config.EXPO_ACCESS_TOKEN) : new LogPushSender(log);
      return { [PUSH_QUEUE]: async (job: Job) => service.sendPush(job.data as PushJob, sender) };
    },
  };
}
