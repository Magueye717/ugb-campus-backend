import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { IdParams, ObjectIdString, toObjectId } from '../../platform/http/schemas.js';
import type { AuditApi } from '../audit/index.js';
import { messageView, type MessagingService } from './messaging.service.js';
import { CONVERSATION_TYPES, MESSAGE_MAX_LENGTH } from './messaging.types.js';

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);
const Identity = Type.Object({ key: Type.String(), name: Type.String(), initials: Type.String(), role: Nullable(Type.String()) });

export const MessageView = Type.Object({
  id: Type.String(),
  conversationId: Type.String(),
  kind: Type.String({ description: 'text | quick_reply | system' }),
  body: Type.String(),
  author: Nullable(Identity),
  clientMessageId: Nullable(Type.String()),
  createdAt: Type.String({ format: 'date-time' }),
});

const ConversationView = Type.Object({
  id: Type.String(),
  type: Type.String({ description: CONVERSATION_TYPES.join(' | ') }),
  contextRef: Type.String({ description: 'The trip, the claim…' }),
  title: Type.String(),
  status: Type.String(),
  canWrite: Type.Boolean(),
  writableUntil: Nullable(Type.String()),
  me: Identity,
  members: Type.Array(Identity),
  /** Members I blocked: the app hides their live messages too. */
  blockedKeys: Type.Array(Type.String()),
  unread: Type.Number(),
});

const MessageParams = Type.Object({ id: ObjectIdString, messageId: ObjectIdString }, { additionalProperties: false });

const identityOf = (m: { key: string; name: string; initials: string; role: string | null }) => ({ key: m.key, name: m.name, initials: m.initials, role: m.role });

export function registerMessagingRoutes(root: FastifyInstance, { service, audit, requireAdmin }: { service: MessagingService; audit: AuditApi; requireAdmin: preHandlerHookHandler }) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const tags = ['messaging'];
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);

  app.get(
    '/conversations',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        querystring: Type.Object({ type: Type.Optional(Type.Enum(CONVERSATION_TYPES)) }, { additionalProperties: false }),
        response: {
          200: Type.Object({
            items: Type.Array(Type.Object({ id: Type.String(), type: Type.String(), contextRef: Type.String(), title: Type.String(), canWrite: Type.Boolean(), unread: Type.Number(), lastMessage: Nullable(MessageView) })),
          }),
        },
      },
    },
    async (req) => ({
      items: (await service.mine(me(req), req.query.type)).map(({ conv, me: m, unread, last }) => ({
        id: conv._id.toHexString(),
        type: conv.type,
        contextRef: conv.contextRef.toHexString(),
        title: conv.title,
        canWrite: service.canWrite(conv, m),
        unread,
        lastMessage: last ? messageView(last) : null,
      })),
    }),
  );

  app.get('/conversations/:id', { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: ConversationView } } }, async (req) => {
    const { conv, me: m } = await service.forMember(toObjectId(req.params.id), me(req));
    return {
      id: conv._id.toHexString(),
      type: conv.type,
      contextRef: conv.contextRef.toHexString(),
      title: conv.title,
      status: conv.status,
      canWrite: service.canWrite(conv, m),
      writableUntil: conv.writableUntil?.toISOString() ?? null,
      me: identityOf(m),
      members: conv.members.map(identityOf),
      blockedKeys: await service.blockedKeys(conv, me(req)),
      unread: await service.unreadCount(conv, me(req)),
    };
  });

  app.get(
    '/conversations/:id/messages',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        params: IdParams,
        querystring: Type.Object(
          { before: Type.Optional(ObjectIdString), after: Type.Optional(ObjectIdString), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ items: Type.Array(MessageView), hasMore: Type.Boolean() }) },
      },
    },
    async (req) => {
      const { items, hasMore } = await service.list(toObjectId(req.params.id), me(req), {
        before: req.query.before ? toObjectId(req.query.before) : undefined,
        after: req.query.after ? toObjectId(req.query.after) : undefined,
        limit: req.query.limit,
      });
      return { items: items.map(messageView), hasMore };
    },
  );

  app.post(
    '/conversations/:id/messages',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        params: IdParams,
        body: Type.Object(
          {
            body: Type.String({ minLength: 1, maxLength: MESSAGE_MAX_LENGTH }),
            kind: Type.Optional(Type.Enum(['text', 'quick_reply'] as const)),
            clientMessageId: Type.String({ minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$', description: 'Made by the app for each message: a retry with the same id returns the first one.' }),
          },
          { additionalProperties: false },
        ),
        response: { 200: MessageView, 201: MessageView },
      },
    },
    async (req, reply) => {
      const { message, replay } = await service.send(toObjectId(req.params.id), me(req), { body: req.body.body, kind: req.body.kind ?? 'text', clientMessageId: req.body.clientMessageId });
      return reply.status(replay ? 200 : 201).send(messageView(message));
    },
  );

  app.post(
    '/conversations/:id/read',
    { preHandler: requireAuth, schema: { tags, params: IdParams, body: Type.Object({ lastReadMessageId: ObjectIdString }, { additionalProperties: false }) } },
    async (req, reply) => {
      await service.markRead(toObjectId(req.params.id), me(req), toObjectId(req.body.lastReadMessageId));
      return reply.status(204).send();
    },
  );

  app.post(
    '/conversations/:id/messages/:messageId/report',
    { preHandler: requireAuth, schema: { tags, params: MessageParams, body: Type.Optional(Type.Object({ reason: Type.Optional(Type.String({ maxLength: 300 })) }, { additionalProperties: false })) } },
    async (req, reply) => {
      await service.report(toObjectId(req.params.id), me(req), toObjectId(req.params.messageId), req.body?.reason ?? null);
      await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'message.report', target: { type: 'message', id: req.params.messageId }, requestId: req.id });
      return reply.status(204).send();
    },
  );

  app.post('/conversations/:id/messages/:messageId/block-author', { preHandler: requireAuth, schema: { tags, params: MessageParams } }, async (req, reply) => {
    await service.blockAuthor(toObjectId(req.params.id), me(req), toObjectId(req.params.messageId));
    return reply.status(204).send();
  });

  app.get(
    '/admin/message-reports',
    {
      preHandler: [requireAuth, requireAdmin],
      schema: {
        tags: ['admin'],
        response: {
          200: Type.Object({
            items: Type.Array(Type.Object({ id: Type.String(), conversationId: Type.String(), conversationType: Type.String(), messageId: Type.String(), body: Type.String(), reason: Nullable(Type.String()), createdAt: Type.String() })),
          }),
        },
      },
    },
    async () => ({
      items: (await service.openReports()).map((r) => ({
        id: r._id.toHexString(), conversationId: r.conversationId.toHexString(), conversationType: r.conversationType,
        messageId: r.messageId.toHexString(), body: r.body, reason: r.reason, createdAt: r.createdAt.toISOString(),
      })),
    }),
  );
}
