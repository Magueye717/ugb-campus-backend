import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { IdParams, ObjectIdString, toObjectId } from '../../platform/http/schemas.js';
import { CAMPUSES } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import { menuView, restoView, type PublicRestosService } from './public-restos.service.js';
import { DISH_STATUSES, MEALS } from './public-restos.types.js';

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);
const HM = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Local time HH:MM (Dakar).' });
const Service = Type.Object({ start: HM, end: HM }, { additionalProperties: false });
const Services = Type.Object({ lunch: Service, dinner: Service });
const DateString = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Local date YYYY-MM-DD (Dakar).' });

const DishView = Type.Object({
  id: Type.String(),
  name: Type.String(),
  detail: Type.String(),
  status: Type.String({ description: 'available | low ("Bientôt fini") | out ("Rupture")' }),
  statusAt: Type.String(),
});
const MenuView = Type.Object({ id: Type.String(), restoId: Type.String(), date: Type.String(), meal: Type.String({ description: 'lunch | dinner' }), dishes: Type.Array(DishView), updatedAt: Type.String() });
const CampusInput = Type.Union([...CAMPUSES.map((c) => Type.Literal(c)), Type.Null()], { description: 'Its ruptures go to that campus’s students only. Null: everyone.' });
const RestoView = Type.Object({ id: Type.String(), slug: Type.String(), name: Type.String(), location: Type.String(), campus: Nullable(Type.String()), coords: Nullable(Type.Object({ lat: Type.Number(), lng: Type.Number() }, { description: 'For directions.' })), sortOrder: Type.Number(), services: Services, status: Type.String() });
const DayView = Type.Object({
  date: Type.String(),
  restos: Type.Array(Type.Object({ ...RestoView.properties, menus: Type.Object({ lunch: Nullable(MenuView), dinner: Nullable(MenuView) }) })),
});

const MenuParams = Type.Object({ id: ObjectIdString, date: DateString, meal: Type.Enum(MEALS) }, { additionalProperties: false });
const DishInput = Type.Object(
  {
    id: Type.Optional(Type.String({ maxLength: 12, description: 'An existing dish of this menu: keeps its stock level.' })),
    name: Type.String({ minLength: 2, maxLength: 60, description: '"Thiébou dieun"' }),
    detail: Type.Optional(Type.String({ maxLength: 80, description: '"Riz au poisson"' })),
    status: Type.Optional(Type.Enum(DISH_STATUSES, { description: 'Default: kept, or available for a new dish.' })),
  },
  { additionalProperties: false },
);

type Deps = { service: PublicRestosService; audit: AuditApi; requireStaff: preHandlerHookHandler };

export function registerPublicRestosRoutes(root: FastifyInstance, { service, audit, requireStaff }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const tags = ['public-restos'];
  const staff = { preHandler: [requireAuth, requireStaff] };
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const trace = (req: FastifyRequest, action: string, id: string, metadata?: Record<string, unknown>) =>
    audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action, target: { type: 'public_resto', id }, requestId: req.id, ...(metadata ? { metadata } : {}) });

  // ---- Students: the home screen and the "Restos publics" tab ----------------------------------------------------

  app.get(
    '/public-restos',
    {
      preHandler: requireAuth,
      schema: { tags, querystring: Type.Object({ date: Type.Optional(DateString) }, { additionalProperties: false }), response: { 200: DayView } },
    },
    async (req) => service.day(req.query.date),
  );

  // ---- Catering staff (back office; Swagger meanwhile) ---------------------------------------------------------

  app.get('/admin/public-restos', { ...staff, schema: { tags, response: { 200: Type.Object({ items: Type.Array(RestoView) }) } } }, async () => ({
    items: (await service.listRestos()).map(restoView),
  }));

  app.post(
    '/admin/public-restos',
    {
      ...staff,
      schema: {
        tags,
        body: Type.Object(
          {
            slug: Type.String({ pattern: '^[a-z0-9-]{2,40}$', description: '"resto-3"' }),
            name: Type.String({ minLength: 2, maxLength: 60 }),
            location: Type.Optional(Type.String({ maxLength: 120 })),
            coords: Type.Optional(Nullable(Type.Object({ lat: Type.Number({ minimum: -90, maximum: 90 }), lng: Type.Number({ minimum: -180, maximum: 180 }) }, { additionalProperties: false }))),
            campus: Type.Optional(CampusInput),
            sortOrder: Type.Optional(Type.Integer()),
            services: Type.Optional(Type.Partial(Services, { description: 'Default: lunch 12:00-15:00, dinner 19:00-21:00.' })),
          },
          { additionalProperties: false },
        ),
        response: { 201: RestoView },
      },
    },
    async (req, reply) => {
      const r = await service.createResto(req.body);
      await trace(req, 'public_resto.create', r._id.toHexString());
      return reply.status(201).send(restoView(r));
    },
  );

  app.patch(
    '/admin/public-restos/:id',
    {
      ...staff,
      schema: {
        tags,
        params: IdParams,
        body: Type.Object(
          {
            name: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
            location: Type.Optional(Type.String({ maxLength: 120 })),
            coords: Type.Optional(Nullable(Type.Object({ lat: Type.Number({ minimum: -90, maximum: 90 }), lng: Type.Number({ minimum: -180, maximum: 180 }) }, { additionalProperties: false }))),
            campus: Type.Optional(CampusInput),
            sortOrder: Type.Optional(Type.Integer()),
            services: Type.Optional(Type.Partial(Services)),
            status: Type.Optional(Type.Enum(['active', 'archived'] as const, { description: 'archived: hidden from students.' })),
          },
          { additionalProperties: false },
        ),
        response: { 200: RestoView },
      },
    },
    async (req) => {
      const r = await service.updateResto(toObjectId(req.params.id), req.body);
      await trace(req, 'public_resto.update', req.params.id);
      return restoView(r);
    },
  );

  app.get(
    '/admin/public-restos/:id/menus',
    {
      ...staff,
      schema: { tags, params: IdParams, querystring: Type.Object({ from: DateString, to: DateString }, { additionalProperties: false }), response: { 200: Type.Object({ items: Type.Array(MenuView) }) } },
    },
    async (req) => ({ items: (await service.menusOf(toObjectId(req.params.id), req.query.from, req.query.to)).map(menuView) }),
  );

  app.put(
    '/admin/public-restos/:id/menus/:date/:meal',
    {
      ...staff,
      schema: {
        tags,
        params: MenuParams,
        body: Type.Object({ dishes: Type.Array(DishInput, { minItems: 1, maxItems: 12 }) }, { additionalProperties: false }),
        response: { 200: MenuView },
      },
    },
    async (req) => {
      const m = await service.putMenu(toObjectId(req.params.id), req.params.date, req.params.meal, req.body.dishes, me(req));
      await trace(req, 'public_menu.publish', req.params.id, { date: req.params.date, meal: req.params.meal, dishes: m.dishes.length });
      return menuView(m);
    },
  );

  app.delete('/admin/public-restos/:id/menus/:date/:meal', { ...staff, schema: { tags, params: MenuParams } }, async (req, reply) => {
    await service.deleteMenu(toObjectId(req.params.id), req.params.date, req.params.meal);
    await trace(req, 'public_menu.delete', req.params.id, { date: req.params.date, meal: req.params.meal });
    return reply.status(204).send();
  });

  // "Rupture" (or a stock level, or back in stock) during the service.
  app.patch(
    '/admin/public-restos/:id/menus/:date/:meal/dishes/:dishId',
    {
      ...staff,
      schema: {
        tags,
        params: Type.Object({ ...MenuParams.properties, dishId: Type.String({ maxLength: 12 }) }, { additionalProperties: false }),
        body: Type.Object(
          {
            status: Type.Enum(DISH_STATUSES, { description: 'out: alert on the home screen until the end of the service (today’s service only).' }),
            notify: Type.Optional(Type.Boolean({ description: 'With out: also a push notification to everyone with the app. Default false.' })),
          },
          { additionalProperties: false },
        ),
        response: { 200: MenuView },
      },
    },
    async (req) => {
      const m = await service.setDishStatus(toObjectId(req.params.id), req.params.date, req.params.meal, req.params.dishId, req.body.status, me(req), !!req.body.notify);
      await trace(req, 'public_menu.dish_status', req.params.id, { date: req.params.date, meal: req.params.meal, dishId: req.params.dishId, status: req.body.status, notify: !!req.body.notify });
      return menuView(m);
    },
  );
}
