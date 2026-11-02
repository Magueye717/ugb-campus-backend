import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { errors } from '../../platform/http/errors.js';
import { IdParams, ObjectIdString, toObjectId } from '../../platform/http/schemas.js';
import { CAMPUSES } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { OrganizationsApi, OrgRole } from '../organizations/index.js';
import { PAYMENT_METHODS, PaymentView, paymentView } from '../payments/index.js';
import type { CommerceService } from './commerce.service.js';
import { BUSINESS_KINDS, ITEM_SECTIONS, ORDER_MODES, type BusinessDoc } from './commerce.types.js';

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);
const Hhmm = Type.String({ pattern: '^\\d{2}:\\d{2}$' });
const ServiceSchema = Type.Object({ start: Hhmm, end: Hhmm }, { additionalProperties: false });
const Location = Type.Object({ lat: Type.Number({ minimum: -90, maximum: 90 }), lng: Type.Number({ minimum: -180, maximum: 180 }) }, { additionalProperties: false });

const ItemView = Type.Object({
  id: Type.String(),
  section: Type.String({ description: ITEM_SECTIONS.join(' | ') }),
  category: Nullable(Type.String({ description: 'Shops: groups the articles ("Fournitures").' })),
  name: Type.String(),
  detail: Type.String(),
  price: Type.Number(),
  photo: Nullable(Type.String()),
  photoId: Nullable(Type.String()),
  stock: Nullable(Type.Number({ description: 'Shops: units left; null: not counted.' })),
  soldOut: Type.Boolean(),
  available: Type.Boolean(),
});
const BusinessView = Type.Object({
  id: Type.String(),
  orgId: Type.String(),
  kind: Type.String({ description: BUSINESS_KINDS.join(' | ') }),
  name: Type.String(),
  specialty: Type.String(),
  description: Type.String(),
  photo: Nullable(Type.String()),
  location: Nullable(Type.Object({ lat: Type.Number(), lng: Type.Number() })),
  address: Type.String(),
  campus: Nullable(Type.String()),
  campusLabel: Nullable(Type.String()),
  phone: Type.String(),
  services: Type.Array(Type.Object({ start: Type.String(), end: Type.String() })),
  hours: Type.String({ description: '"12h-15h · 19h-22h"' }),
  open: Type.Boolean({ description: 'Takes orders now (within its hours and not paused).' }),
  statusLabel: Type.String({ description: '"Ouvert · jusqu’à 15h", "Fermé · ouvre à 19h", "Commandes en pause"' }),
  deliveryFee: Nullable(Type.Number({ description: 'FCFA, 0: free; null: pickup only.' })),
  acceptingOrders: Type.Boolean(),
  active: Type.Boolean(),
});
const ListedBusiness = Type.Object({ ...BusinessView.properties, highlights: Type.Array(ItemView), minPrice: Nullable(Type.Number()), itemsCount: Type.Number(), itemNames: Type.Array(Type.String(), { description: 'Every available item: for searching.' }) });
const BusinessDetail = Type.Object({ ...BusinessView.properties, items: Type.Array(ItemView) });
const OrderView = Type.Object({
  id: Type.String(),
  code: Type.String({ description: 'Said at the counter: "C7KQ2M".' }),
  status: Type.String({ description: 'pending_payment | placed | accepted | ready | completed | refused | cancelled | expired' }),
  business: Type.Object({ id: Type.String(), kind: Type.String(), name: Type.String(), phone: Type.String(), photo: Nullable(Type.String()), address: Type.String() }),
  lines: Type.Array(Type.Object({ itemId: Type.String(), name: Type.String(), price: Type.Number(), qty: Type.Number(), photo: Type.Union([Type.String(), Type.Null()]) })),
  subtotal: Type.Number(),
  deliveryFee: Type.Number(),
  total: Type.Number(),
  mode: Type.String({ description: ORDER_MODES.join(' | ') }),
  address: Nullable(Type.String()),
  note: Nullable(Type.String()),
  refusal: Nullable(Type.String()),
  refunded: Type.Boolean(),
  history: Type.Array(Type.Object({ status: Type.String(), at: Type.String() })),
  createdAt: Type.String(),
  payment: Nullable(Type.Object({ reference: Type.String(), checkoutUrl: Nullable(Type.String()) }, { description: 'Being paid: reopen the checkout.' })),
  customer: Nullable(Type.Object({ name: Type.String(), phone: Type.String() }, { description: 'Business only: who ordered.' })),
});
const ProfileBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
    specialty: Type.Optional(Type.String({ maxLength: 40 })),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    photoId: Type.Optional(Nullable(ObjectIdString)),
    location: Type.Optional(Nullable(Location)),
    address: Type.Optional(Type.String({ maxLength: 80 })),
    campus: Type.Optional(Nullable(Type.Enum(CAMPUSES))),
    phone: Type.Optional(Type.String({ maxLength: 20 })),
    services: Type.Optional(Type.Array(ServiceSchema, { minItems: 1, maxItems: 4 })),
    deliveryFee: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 5000 }))),
    acceptingOrders: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const ItemFields = {
  section: Type.Enum(ITEM_SECTIONS),
  category: Type.Optional(Nullable(Type.String({ maxLength: 30 }))),
  name: Type.String({ minLength: 2, maxLength: 50 }),
  detail: Type.Optional(Type.String({ maxLength: 120 })),
  price: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  photoId: Type.Optional(Nullable(ObjectIdString)),
  stock: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 100_000 }))),
  available: Type.Optional(Type.Boolean()),
  sortOrder: Type.Optional(Type.Number()),
};
const OrgParams = Type.Object({ orgId: ObjectIdString }, { additionalProperties: false });
const OrgItemParams = Type.Object({ orgId: ObjectIdString, itemId: ObjectIdString }, { additionalProperties: false });
const OrgOrderParams = Type.Object({ orgId: ObjectIdString, id: ObjectIdString }, { additionalProperties: false });

type Deps = {
  service: CommerceService;
  audit: AuditApi;
  requireOrgRole: (roles: OrgRole[]) => preHandlerHookHandler;
  roleIn: OrganizationsApi['roleIn'];
  requireAdmin: preHandlerHookHandler;
};
const baseUrlOf = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

export function registerCommerceRoutes(root: FastifyInstance, { service, audit, requireOrgRole, roleIn, requireAdmin }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const tags = ['commerce'];
  const managers = { preHandler: [requireAuth, requireOrgRole(['owner', 'manager'])] };
  const team = { preHandler: [requireAuth, requireOrgRole(['owner', 'manager', 'staff'])] };
  const trace = (req: FastifyRequest, action: string, type: string, id: string, metadata?: Record<string, unknown>) =>
    audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action, target: { type, id }, requestId: req.id, ...(metadata ? { metadata } : {}) });
  const view = (b: BusinessDoc) => service.publicView(b);

  // ---- Students -------------------------------------------------------------------------------------------------

  app.get(
    '/businesses',
    { preHandler: requireAuth, schema: { tags, description: 'Private restaurants or shops, open first, with a few of their items.', querystring: Type.Object({ kind: Type.Enum(BUSINESS_KINDS) }, { additionalProperties: false }), response: { 200: Type.Object({ items: Type.Array(ListedBusiness) }) } } },
    async (req) => ({ items: await service.list(req.query.kind) }),
  );

  app.get(
    '/market',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        description: 'The market: every available article of every shop (or every dish of every restaurant), with its business, to browse and search across them.',
        querystring: Type.Object({ kind: Type.Enum(BUSINESS_KINDS) }, { additionalProperties: false }),
        response: { 200: Type.Object({ businesses: Type.Array(BusinessView), items: Type.Array(Type.Object({ ...ItemView.properties, businessId: Type.String() })) }) },
      },
    },
    async (req) => service.market(req.query.kind),
  );

  app.get('/businesses/:id', { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: BusinessDetail } } }, async (req) => service.detail(toObjectId(req.params.id)));

  app.post(
    '/businesses/:id/orders',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        params: IdParams,
        description: 'One order, paid now (Wave / Orange Money). The business is notified once paid.',
        body: Type.Object(
          {
            lines: Type.Array(Type.Object({ itemId: ObjectIdString, qty: Type.Integer({ minimum: 0, maximum: 20 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
            mode: Type.Enum(ORDER_MODES),
            address: Type.Optional(Nullable(Type.String({ maxLength: 120 }))),
            note: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
            method: Type.Enum(PAYMENT_METHODS),
            returnUrl: Type.Optional(Type.String({ maxLength: 300 })),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ order: OrderView, payment: PaymentView }) },
      },
    },
    async (req, reply) => {
      const { order, payment } = await service.place(me(req), toObjectId(req.params.id), req.body, baseUrlOf(req));
      return reply.status(201).send({ order: await service.mineOne(me(req), order._id), payment: paymentView(payment) });
    },
  );

  app.get('/me/orders', { preHandler: requireAuth, schema: { tags, response: { 200: Type.Object({ items: Type.Array(OrderView) }) } } }, async (req) => ({ items: await service.mine(me(req)) }));
  app.get('/me/orders/:id', { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: OrderView } } }, async (req) => service.mineOne(me(req), toObjectId(req.params.id)));
  app.post('/me/orders/:id/cancel', { preHandler: requireAuth, schema: { tags, params: IdParams, description: 'Before the business accepts it: refunded.', response: { 200: OrderView } } }, async (req) => {
    await service.cancel(me(req), toObjectId(req.params.id));
    return service.mineOne(me(req), toObjectId(req.params.id));
  });

  // ---- The business's own space (members: /org/:orgId/members, owner) ----------------------------------------------

  app.get('/org/:orgId/business', { ...team, schema: { tags, params: OrgParams, response: { 200: BusinessView } } }, async (req) => view(await service.ofOrg(toObjectId(req.params.orgId))));

  app.patch('/org/:orgId/business', { ...managers, schema: { tags, params: OrgParams, description: 'Picture, GPS point, address, hours, delivery, pause orders…', body: ProfileBody, response: { 200: BusinessView } } }, async (req) => {
    const b = await service.update(toObjectId(req.params.orgId), me(req), req.body);
    await trace(req, 'business.update', 'business', b._id.toHexString(), { fields: Object.keys(req.body) });
    return view(b);
  });

  app.get('/org/:orgId/catalog', { ...team, schema: { tags, params: OrgParams, response: { 200: Type.Object({ items: Type.Array(ItemView) }) } } }, async (req) => {
    const b = await service.ofOrg(toObjectId(req.params.orgId));
    return { items: (await service.catalog(b._id)).map((i) => service.itemView(i)) };
  });

  app.post('/org/:orgId/catalog', { ...managers, schema: { tags, params: OrgParams, description: 'Restaurants: menu or drink. Shops: article (with stock).', body: Type.Object(ItemFields, { additionalProperties: false }), response: { 201: ItemView } } }, async (req, reply) => {
    const item = await service.addItem(toObjectId(req.params.orgId), me(req), req.body);
    return reply.status(201).send(service.itemView(item));
  });

  app.patch(
    '/org/:orgId/catalog/:itemId',
    { ...team, schema: { tags, params: OrgItemParams, description: 'Staff may only switch availability (sold out today).', body: Type.Partial(Type.Object(ItemFields, { additionalProperties: false })), response: { 200: ItemView } } },
    async (req) => {
      const orgId = toObjectId(req.params.orgId);
      const onlyAvailability = Object.keys(req.body).every((k) => k === 'available');
      if (!onlyAvailability && !(await roleIn(orgId, me(req), ['owner', 'manager']))) throw errors.forbidden('Seuls le propriétaire et les gérants modifient le catalogue.');
      return service.itemView(await service.updateItem(orgId, me(req), toObjectId(req.params.itemId), req.body));
    },
  );

  app.delete('/org/:orgId/catalog/:itemId', { ...managers, schema: { tags, params: OrgItemParams } }, async (req, reply) => {
    await service.removeItem(toObjectId(req.params.orgId), toObjectId(req.params.itemId));
    return reply.status(204).send();
  });

  app.get(
    '/org/:orgId/orders',
    { ...team, schema: { tags, params: OrgParams, querystring: Type.Object({ scope: Type.Optional(Type.Enum(['active', 'done'] as const)) }, { additionalProperties: false }), response: { 200: Type.Object({ items: Type.Array(OrderView) }) } } },
    async (req) => ({ items: await service.queue(toObjectId(req.params.orgId), req.query.scope ?? 'active') }),
  );

  app.post(
    '/org/:orgId/orders/handover',
    {
      ...team,
      schema: {
        tags,
        params: OrgParams,
        description: 'At the counter: the order code the student gives (typed, or their QR scanned). Completes an order being prepared or ready.',
        body: Type.Object({ code: Type.String({ minLength: 3, maxLength: 24 }) }, { additionalProperties: false }),
        response: { 200: OrderView },
      },
    },
    async (req) => {
      const o = await service.handover(toObjectId(req.params.orgId), req.body.code, me(req));
      await trace(req, 'order.handover', 'order', o._id.toHexString());
      return service.businessOrder(o.orgId, o._id);
    },
  );

  app.get('/org/:orgId/orders/:id', { ...team, schema: { tags, params: OrgOrderParams, response: { 200: OrderView } } }, async (req) => service.businessOrder(toObjectId(req.params.orgId), toObjectId(req.params.id)));

  for (const [path, to] of [['accept', 'accepted'], ['ready', 'ready'], ['complete', 'completed']] as const) {
    app.post(`/org/:orgId/orders/:id/${path}`, { ...team, schema: { tags, params: OrgOrderParams, response: { 200: OrderView } } }, async (req) => {
      const { orgId, id } = req.params as { orgId: string; id: string };
      await service.advance(toObjectId(orgId), toObjectId(id), me(req), to);
      await trace(req, `order.${path}`, 'order', id);
      return service.businessOrder(toObjectId(orgId), toObjectId(id));
    });
  }

  app.post(
    '/org/:orgId/orders/:id/refuse',
    { ...team, schema: { tags, params: OrgOrderParams, description: 'A placed order only: the student is refunded and told why.', body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 200 }) }, { additionalProperties: false }), response: { 200: OrderView } } },
    async (req) => {
      await service.refuse(toObjectId(req.params.orgId), toObjectId(req.params.id), me(req), req.body.reason);
      await trace(req, 'order.refuse', 'order', req.params.id, { reason: req.body.reason });
      return service.businessOrder(toObjectId(req.params.orgId), toObjectId(req.params.id));
    },
  );

  // ---- Admins -----------------------------------------------------------------------------------------------------

  const admin = { preHandler: [requireAuth, requireAdmin] };
  app.get('/admin/businesses', { ...admin, schema: { tags: ['admin'], response: { 200: Type.Object({ items: Type.Array(BusinessView) }) } } }, async () => ({ items: (await service.listAll()).map(view) }));

  app.post(
    '/admin/businesses',
    {
      ...admin,
      schema: {
        tags: ['admin'],
        description: 'Creates a restaurant or a shop: its organization, its owner (account created for a new number) and its profile. The owner then adds their team.',
        body: Type.Object(
          {
            ...ProfileBody.properties,
            kind: Type.Enum(BUSINESS_KINDS),
            name: Type.String({ minLength: 2, maxLength: 60 }),
            specialty: Type.String({ minLength: 2, maxLength: 40 }),
            owner: Type.Object({ phone: Type.String({ maxLength: 20 }), firstName: Type.String({ minLength: 2, maxLength: 40 }), lastName: Type.String({ minLength: 2, maxLength: 40 }) }, { additionalProperties: false }),
          },
          { additionalProperties: false },
        ),
        response: { 201: BusinessView },
      },
    },
    async (req, reply) => {
      const b = await service.create(req.body);
      await trace(req, 'business.create', 'business', b._id.toHexString(), { kind: b.kind });
      return reply.status(201).send(view(b));
    },
  );

  app.patch(
    '/admin/businesses/:id',
    { ...admin, schema: { tags: ['admin'], params: IdParams, description: 'Hide (or show again) a business.', body: Type.Object({ active: Type.Boolean() }, { additionalProperties: false }), response: { 200: BusinessView } } },
    async (req) => view(await service.setActive(toObjectId(req.params.id), req.body.active)),
  );
}
