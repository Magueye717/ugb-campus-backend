import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { IdParams, toObjectId } from '../../platform/http/schemas.js';
import { PAYMENT_METHODS, PaymentView, paymentView, PayoutView, payoutView } from '../payments/index.js';
import type { TaxiService } from './taxi.service.js';
import { TAXI_FARE, TAXI_LOCK_CHOICE, TAXI_SEATS } from './taxi.types.js';

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);
const Person = { key: Type.String(), name: Type.String(), initials: Type.String() };

export const TripView = Type.Object({
  id: Type.String(),
  from: Type.String(),
  to: Type.String(),
  departureAt: Type.String({ format: 'date-time' }),
  lockAt: Type.String({ format: 'date-time' }),
  chatClosesAt: Type.String({ format: 'date-time' }),
  seats: Type.Number(),
  seatsTaken: Type.Number({ description: 'Organizer, paid seats, unpaid holds and seats kept after a late leave.' }),
  fare: Type.Number(),
  seatPrice: Type.Number(),
  status: Type.String({ description: 'open | departed | cancelled' }),
  organizer: Type.Object({ ...Person, trips: Type.Number(), lateCancels: Type.Number() }),
  passengers: Type.Array(Type.Object({ ...Person, role: Type.String(), checkedIn: Type.Boolean() })),
  vehicle: Nullable(Type.String()),
  conversationId: Nullable(Type.String({ description: 'Trip chat (GET /conversations/{id}), for the people in the trip only.' })),
  me: Nullable(
    Type.Object({
      key: Type.String(),
      role: Type.String(),
      status: Type.String({ description: 'pending_payment | joined | left | expired' }),
      checkedIn: Type.Boolean(),
      forfeited: Type.Boolean(),
      payment: Nullable(Type.Object({ reference: Type.String(), checkoutUrl: Nullable(Type.String()), expiresAt: Type.String() })),
    }),
  ),
  claim: Nullable(Type.Object({ amount: Type.Number(), payout: Nullable(Type.Object({ id: Type.String(), status: Type.String(), amount: Type.Number() })) })),
});

const Standing = { strikes: Type.Number(), limit: Type.Number(), suspendedUntil: Nullable(Type.String()) };

const NewTripBody = Type.Object(
  {
    from: Type.String({ minLength: 2, maxLength: 80 }),
    to: Type.String({ minLength: 2, maxLength: 80 }),
    seats: Type.Integer({ minimum: TAXI_SEATS.min, maximum: TAXI_SEATS.max, description: 'Seats in the taxi, organizer included.' }),
    fare: Type.Integer({ minimum: TAXI_FARE.min, maximum: TAXI_FARE.max, description: 'Whole fare in FCFA.' }),
    departureAt: Type.Optional(Type.String({ format: 'date-time' })),
    leaveInMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_080, description: 'Instead of departureAt: measured on the server clock, safe from a phone set to the wrong time.' })),
    lockMinutes: Type.Optional(
      Type.Integer({ minimum: TAXI_LOCK_CHOICE.min, maximum: TAXI_LOCK_CHOICE.max, description: '"Non remboursable X minutes avant le départ". Default 10 (never earlier than half-way to the departure).' }),
    ),
  },
  { additionalProperties: false },
);
const MethodBody = Type.Object({ method: Type.Enum(PAYMENT_METHODS) }, { additionalProperties: false });
const JoinBody = Type.Object(
  { method: Type.Enum(PAYMENT_METHODS), returnUrl: Type.Optional(Type.String({ maxLength: 300, description: 'App deep link the checkout page returns to.' })) },
  { additionalProperties: false },
);

/** Base URL for checkout links: the host the app called, so a phone on the Wi-Fi gets a link it can open. */
const baseUrlOf = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

export function registerTaxiRoutes(root: FastifyInstance, { service, requireStudent }: { service: TaxiService; requireStudent: preHandlerHookHandler }) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const guard = { preHandler: [requireAuth, requireStudent] };
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const tags = ['taxi'];
  const viewOf = async (req: FastifyRequest, id: string) => service.view(me(req), await service.getVisible(me(req), toObjectId(id)));

  app.get(
    '/taxi/trips',
    { ...guard, schema: { tags, response: { 200: Type.Object({ serverTime: Type.String(), items: Type.Array(TripView) }) } } },
    async (req) => ({ serverTime: new Date().toISOString(), items: await service.views(me(req), await service.board(me(req))) }),
  );

  app.get('/taxi/trips/:id', { ...guard, schema: { tags, params: IdParams, response: { 200: TripView } } }, async (req) => viewOf(req, req.params.id));

  app.get(
    '/taxi/me',
    { ...guard, schema: { tags, response: { 200: Type.Object({ key: Type.String(), ...Standing, activeTripId: Nullable(Type.String()) }) } } },
    async (req) => {
      const [standing, active] = await Promise.all([service.standing(me(req)), service.activeTripOf(me(req))]);
      return {
        key: service.personKey(me(req)),
        ...standing,
        suspendedUntil: standing.suspendedUntil?.toISOString() ?? null,
        activeTripId: active?._id.toHexString() ?? null,
      };
    },
  );

  app.post('/taxi/trips', { ...guard, schema: { tags, body: NewTripBody, response: { 200: TripView, 201: TripView } } }, async (req, reply) => {
    const { trip, replay } = await service.create(me(req), req.body);
    return reply.status(replay ? 200 : 201).send(await service.view(me(req), trip));
  });

  app.post(
    '/taxi/trips/:id/join',
    { ...guard, schema: { tags, params: IdParams, body: JoinBody, response: { 200: Type.Object({ trip: TripView, payment: PaymentView }), 201: Type.Object({ trip: TripView, payment: PaymentView }) } } },
    async (req, reply) => {
      const { trip, payment, replay } = await service.join(me(req), toObjectId(req.params.id), req.body, baseUrlOf(req));
      return reply.status(replay ? 200 : 201).send({ trip: await service.view(me(req), trip), payment: paymentView(payment) });
    },
  );

  app.get(
    '/taxi/trips/:id/leave-quote',
    { ...guard, schema: { tags, params: IdParams, response: { 200: Type.Object({ refundAmount: Type.Number(), locked: Type.Boolean() }) } } },
    async (req) => service.leaveQuote(me(req), toObjectId(req.params.id)),
  );

  app.post(
    '/taxi/trips/:id/leave',
    { ...guard, schema: { tags, params: IdParams, response: { 200: Type.Object({ refundAmount: Type.Number(), forfeited: Type.Boolean() }) } } },
    async (req) => service.leave(me(req), toObjectId(req.params.id)),
  );

  app.post(
    '/taxi/trips/:id/cancel',
    { ...guard, schema: { tags, params: IdParams, response: { 200: Type.Object({ refunded: Type.Number(), strike: Type.Boolean(), ...Standing }) } } },
    async (req) => {
      const res = await service.cancel(me(req), toObjectId(req.params.id));
      return { ...res, suspendedUntil: res.suspendedUntil?.toISOString() ?? null };
    },
  );

  app.post('/taxi/trips/:id/handover', { ...guard, schema: { tags, params: IdParams, response: { 200: TripView } } }, async (req) => {
    await service.handOver(me(req), toObjectId(req.params.id));
    return viewOf(req, req.params.id);
  });

  app.post('/taxi/trips/:id/check-in', { ...guard, schema: { tags, params: IdParams, response: { 200: TripView } } }, async (req) => {
    await service.checkIn(me(req), toObjectId(req.params.id));
    return viewOf(req, req.params.id);
  });

  app.put(
    '/taxi/trips/:id/vehicle',
    { ...guard, schema: { tags, params: IdParams, body: Type.Object({ label: Type.String({ minLength: 2, maxLength: 60 }) }, { additionalProperties: false }), response: { 200: TripView } } },
    async (req) => {
      await service.setVehicle(me(req), toObjectId(req.params.id), req.body.label);
      return viewOf(req, req.params.id);
    },
  );

  app.post('/taxi/trips/:id/depart', { ...guard, schema: { tags, params: IdParams, response: { 200: TripView } } }, async (req) => {
    await service.depart(me(req), toObjectId(req.params.id));
    return viewOf(req, req.params.id);
  });

  app.post('/taxi/trips/:id/claim', { ...guard, schema: { tags, params: IdParams, body: MethodBody, response: { 200: PayoutView } } }, async (req) =>
    payoutView(await service.claim(me(req), toObjectId(req.params.id), req.body.method)),
  );
}

