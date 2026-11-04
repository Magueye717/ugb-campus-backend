import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { IdParams, Nullable, ObjectIdString, PhoneInput, toObjectId } from '../../platform/http/schemas.js';
import type { AuditApi } from '../audit/index.js';
import type { TicketingService } from './ticketing.service.js';

const Free = Type.Record(Type.String(), Type.Unknown(), { description: 'Kind-specific (caravan: pickup, dropoff, vehicle, departure state).' });

export const EventSummaryView = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  title: Type.String(),
  startsAt: Type.String(),
  status: Type.String(),
  organizer: Type.Object({ id: Type.String(), name: Type.String(), category: Type.String(), level: Type.String(), rating: Nullable(Type.Number()), trips: Type.Number() }),
});

const TransferView = Type.Object({
  id: Type.String(),
  ticketId: Type.String(),
  status: Type.String(),
  expiresAt: Type.String(),
  from: Type.Object({ name: Type.String() }),
  to: Type.Object({ name: Type.String(), phoneMasked: Type.String() }),
});

const Quote = Type.Union([
  Type.Object({ allowed: Type.Literal(true), fee: Type.Number(), refund: Type.Number(), freeUntil: Nullable(Type.String()) }),
  Type.Object({ allowed: Type.Literal(false), reason: Type.String() }),
]);

export const TicketView = Type.Object({
  id: Type.String(),
  kind: Type.String({ description: 'caravan_seat (other kinds later: events…)' }),
  code: Type.String({ description: 'Typed by the scanner when the QR can’t be shown.' }),
  status: Type.String({ description: 'active | cancelled | transferred (I gave it to someone)' }),
  seat: Nullable(Type.Number()),
  price: Type.Number(),
  paidWith: Type.String(),
  event: EventSummaryView,
  details: Free,
  passenger: Nullable(Type.Object({ name: Type.String(), phone: Type.String() }, { description: 'Companion ticket: who travels on it (booked by the holder, no account needed).' })),
  purchaser: Type.Object({ name: Type.String(), isMe: Type.Boolean() }),
  qr: Nullable(Type.String({ description: 'Signed payload to render as a QR code. Holder of an active ticket only.' })),
  admittedAt: Nullable(Type.String()),
  cancellation: Nullable(Type.Object({ at: Type.String(), fee: Type.Number(), refundAmount: Type.Number(), reason: Type.String() })),
  cancellationQuote: Nullable(Quote),
  transferDeadline: Nullable(Type.String()),
  transfer: Nullable(TransferView),
});

const ScanResultView = Type.Object({
  result: Type.String({ description: 'admitted | duplicate | rejected' }),
  tone: Type.String({ description: 'success | warning | danger' }),
  title: Type.String(),
  text: Type.String(),
  reason: Nullable(Type.String()),
  eventId: Nullable(Type.String()),
  ticket: Nullable(Type.Object({ id: Type.String(), code: Type.String(), seat: Nullable(Type.Number()) })),
  holder: Nullable(Type.Object({ name: Type.String() }, { description: 'Who travels: the companion’s name on a companion ticket.' })),
  companionOf: Nullable(Type.String({ description: 'Companion ticket: the student who booked it.' })),
  group: Nullable(
    Type.Object(
      {
        size: Type.Number(),
        purchaser: Type.String(),
        others: Type.Array(Type.Object({ ticketId: Type.String(), seat: Nullable(Type.Number()), name: Type.String(), admitted: Type.Boolean() })),
      },
      { description: 'The purchaser’s other valid tickets on this event: "Faire monter les 2" admits them by ticketId.' },
    ),
  ),
});

const ScanBody = Type.Object(
  {
    qr: Type.Optional(Type.String({ maxLength: 1000 })),
    code: Type.Optional(Type.String({ maxLength: 12 })),
    ticketId: Type.Optional(ObjectIdString),
    eventId: Type.Optional(ObjectIdString),
    locationId: Type.Optional(Type.String({ maxLength: 40 })),
    clientScanId: Type.Optional(Type.String({ minLength: 8, maxLength: 64 })),
    deviceId: Type.Optional(Type.String({ maxLength: 64 })),
    scannedAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
);

type Deps = { service: TicketingService; audit: AuditApi; requireOrgRole: (roles: ('owner' | 'manager' | 'scanner' | 'staff')[], space?: 'organizer') => preHandlerHookHandler };

export function registerTicketingRoutes(root: FastifyInstance, { service, audit, requireOrgRole }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const tags = ['tickets'];

  // ---- Holder ----------------------------------------------------------------------------------------------------

  app.get('/tickets', { preHandler: requireAuth, schema: { tags, response: { 200: Type.Object({ items: Type.Array(TicketView) }) } } }, async (req) => ({
    items: await service.mine(me(req)),
  }));

  app.get('/tickets/:id', { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: TicketView } } }, async (req) =>
    service.getFor(toObjectId(req.params.id), me(req)),
  );

  app.post(
    '/tickets/:id/cancel',
    { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: Type.Object({ refundAmount: Type.Number(), fee: Type.Number() }) } } },
    async (req) => {
      const res = await service.cancel(toObjectId(req.params.id), me(req));
      await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'ticket.cancel', target: { type: 'ticket', id: req.params.id }, requestId: req.id, metadata: res });
      return res;
    },
  );

  app.post(
    '/tickets/:id/transfers',
    { preHandler: requireAuth, schema: { tags, params: IdParams, body: Type.Object({ recipientPhone: PhoneInput }, { additionalProperties: false }), response: { 201: TransferView } } },
    async (req, reply) => {
      const transfer = await service.offer(toObjectId(req.params.id), me(req), req.body.recipientPhone);
      await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'ticket.transfer_offer', target: { type: 'ticket', id: req.params.id }, requestId: req.id });
      return reply.status(201).send(transfer);
    },
  );

  app.get(
    '/ticket-transfers',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        querystring: Type.Object({ direction: Type.Enum(['incoming', 'outgoing'] as const) }, { additionalProperties: false }),
        response: { 200: Type.Object({ items: Type.Array(Type.Object({ ...TransferView.properties, seat: Nullable(Type.Number()), event: Nullable(EventSummaryView), details: Free, forCompanion: Type.Boolean({ description: 'The sender booked this seat for me ("t’a réservé une place").' }) })) }) },
      },
    },
    async (req) => ({ items: await service.listTransfers(me(req), req.query.direction) }),
  );

  app.post(
    '/ticket-transfers/:id/accept',
    { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: Type.Object({ status: Type.String(), ticketId: Nullable(Type.String()) }) } } },
    async (req) => service.respond(toObjectId(req.params.id), me(req), true),
  );

  app.post(
    '/ticket-transfers/:id/decline',
    { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: Type.Object({ status: Type.String(), ticketId: Nullable(Type.String()) }) } } },
    async (req) => service.respond(toObjectId(req.params.id), me(req), false),
  );

  app.post('/ticket-transfers/:id/cancel', { preHandler: requireAuth, schema: { tags, params: IdParams } }, async (req, reply) => {
    await service.withdraw(toObjectId(req.params.id), me(req));
    return reply.status(204).send();
  });

  // ---- Organizer: scanning ------------------------------------------------------------------------------------

  const scanners = { preHandler: [requireAuth, requireOrgRole(['owner', 'manager', 'scanner'], 'organizer')] };
  const OrgParams = Type.Object({ orgId: ObjectIdString }, { additionalProperties: false });

  // "Faire monter": a QR code, a typed code, or a ticket ticked in the passenger list (manual).
  app.post('/org/:orgId/admissions', { ...scanners, schema: { tags: ['organizer'], params: OrgParams, body: ScanBody, response: { 200: ScanResultView } } }, async (req) =>
    service.admit(toObjectId(req.params.orgId), me(req), req.body),
  );

  // Scans made offline (no network between towns), sent when the phone is back online. Idempotent per clientScanId.
  app.post(
    '/org/:orgId/admissions/batch',
    {
      ...scanners,
      schema: {
        tags: ['organizer'],
        params: OrgParams,
        body: Type.Object({ items: Type.Array(ScanBody, { minItems: 1, maxItems: 200 }) }, { additionalProperties: false }),
        response: { 200: Type.Object({ items: Type.Array(ScanResultView) }) },
      },
    },
    async (req) => {
      const items = [];
      for (const scan of req.body.items) items.push(await service.admit(toObjectId(req.params.orgId), me(req), scan));
      return { items };
    },
  );

  // "Faire descendre": undo a boarding. Kept in the log, marked void.
  app.post(
    '/org/:orgId/tickets/:ticketId/admission/void',
    {
      ...scanners,
      schema: {
        tags: ['organizer'],
        params: Type.Object({ orgId: ObjectIdString, ticketId: ObjectIdString }, { additionalProperties: false }),
        body: Type.Optional(Type.Object({ reason: Type.Optional(Type.String({ maxLength: 200 })) }, { additionalProperties: false })),
      },
    },
    async (req, reply) => {
      await service.voidAdmission(toObjectId(req.params.orgId), toObjectId(req.params.ticketId), me(req), req.body?.reason ?? null);
      await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'admission.void', target: { type: 'ticket', id: req.params.ticketId }, requestId: req.id });
      return reply.status(204).send();
    },
  );
}
