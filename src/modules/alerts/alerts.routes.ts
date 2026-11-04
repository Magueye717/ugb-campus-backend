import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { IdParams, Nullable, toObjectId } from '../../platform/http/schemas.js';
import { CAMPUSES, REGIONS, UFR_CODES, type AudienceProfile } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import { alertView, type AlertsService, type Editor } from './alerts.service.js';
import { ALERT_PLACEMENTS, ALERT_TONES, type AlertInput } from './alerts.types.js';


export const AlertView = Type.Object({
  id: Type.String(),
  kind: Type.String({ description: 'campus (communication team) | academic (academic team) | resto_stock (a dish sold out)' }),
  placement: Type.String({ description: 'banner (strip at the top, short and urgent) | headline ("À la une")' }),
  tag: Nullable(Type.String({ description: '"À la une" label: Élections, Bourses…' })),
  title: Type.String(),
  body: Type.String(),
  icon: Type.String({ description: 'Ionicons name.' }),
  tone: Type.String({ description: 'info | warning | danger (urgent, shown in red) | success' }),
  href: Nullable(Type.String({ description: 'App route opened on tap; null: display only.' })),
  eventAt: Nullable(Type.String({ description: 'The day it’s about (the vote, the payment).' })),
  audience: Type.Object(
    { campuses: Type.Array(Type.String()), ufrs: Type.Array(Type.String()), regions: Type.Array(Type.String()) },
    { description: 'Who it’s for. Each list narrows (UFR SAT + Campus 1 = SAT students on Campus 1); all empty: the whole university.' },
  ),
  startsAt: Type.String(),
  endsAt: Type.String(),
});
const AdminAlertView = Type.Object({
  ...AlertView.properties,
  status: Type.String({ description: 'scheduled | live | ended | withdrawn' }),
  push: Type.Boolean(),
  pushedAt: Nullable(Type.String({ description: 'When the push left (when the alert went online).' })),
  editable: Type.Boolean({ description: 'This editor may change it (their team’s, not over, not a restaurant’s).' }),
  withdrawable: Type.Boolean(),
});

const Fields = {
  placement: Type.Optional(Type.Enum(ALERT_PLACEMENTS, { description: 'Default banner.' })),
  tag: Type.Optional(Nullable(Type.String({ minLength: 2, maxLength: 24, description: 'Required for headline: "Élections", "Bourses".' }))),
  title: Type.String({ minLength: 3, maxLength: 80, description: '"Élections des délégués"' }),
  body: Type.String({ maxLength: 200, description: '"Vote jeudi 06 nov. · 8h-17h · salle polyvalente"' }),
  icon: Type.Optional(Type.String({ maxLength: 40, description: 'Ionicons name. Default megaphone-outline (headline) / warning-outline (banner).' })),
  tone: Type.Optional(Type.Enum(ALERT_TONES, { description: 'Default info (headline) / warning (banner).' })),
  href: Type.Optional(Nullable(Type.String({ maxLength: 200, pattern: '^/', description: 'App route opened on tap.' }))),
  eventAt: Type.Optional(Nullable(Type.String({ format: 'date-time', description: 'The day it’s about.' }))),
  audience: Type.Optional(
    Type.Object(
      {
        campuses: Type.Array(Type.Union(CAMPUSES.map((c) => Type.Literal(c))), { maxItems: CAMPUSES.length }),
        ufrs: Type.Array(Type.Union(UFR_CODES.map((c) => Type.Literal(c))), { maxItems: UFR_CODES.length }),
        regions: Type.Array(Type.Union(REGIONS.map((r) => Type.Literal(r))), { maxItems: REGIONS.length }),
      },
      { additionalProperties: false, description: 'Default: the whole university. Codes: GET /reference/student.' },
    ),
  ),
  startsAt: Type.Optional(Type.String({ format: 'date-time', description: 'Default: now. Later: scheduled, appears then.' })),
  endsAt: Type.String({ format: 'date-time' }),
  push: Type.Optional(Type.Boolean({ description: 'Push to everyone with the app when it goes online. Default false.' })),
};

type Deps = {
  service: AlertsService;
  audit: AuditApi;
  requireEditor: preHandlerHookHandler;
  rolesOf: (userId: string) => Promise<readonly string[]>;
  audienceOf: (userId: string) => Promise<AudienceProfile>;
};

export function registerAlertsRoutes(root: FastifyInstance, { service, audit, requireEditor, rolesOf, audienceOf }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const tags = ['alerts'];
  const editor = { preHandler: [requireAuth, requireEditor] };
  const who = async (req: FastifyRequest): Promise<Editor> => ({ userId: toObjectId(actorOf(req).userId), roles: await rolesOf(actorOf(req).userId) });
  const trace = (req: FastifyRequest, action: string, id: string, metadata?: Record<string, unknown>) =>
    audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action, target: { type: 'alert', id }, requestId: req.id, ...(metadata ? { metadata } : {}) });
  const input = (b: { [K in keyof typeof Fields]?: unknown } & Record<string, unknown>, now: Date): Omit<AlertInput, 'kind'> => {
    const placement = (b.placement as AlertInput['placement'] | undefined) ?? 'banner';
    return {
      placement,
      tag: ((b.tag as string | null | undefined) ?? null)?.trim() || null,
      title: (b.title as string).trim(),
      body: (b.body as string).trim(),
      icon: (b.icon as string | undefined) ?? (placement === 'headline' ? 'megaphone-outline' : 'warning-outline'),
      tone: (b.tone as AlertInput['tone'] | undefined) ?? (placement === 'headline' ? 'info' : 'warning'),
      href: (b.href as string | null | undefined) ?? null,
      eventAt: b.eventAt ? new Date(b.eventAt as string) : null,
      audience: (b.audience as AlertInput['audience'] | undefined) ?? { campuses: [], ufrs: [], regions: [] },
      startsAt: b.startsAt ? new Date(b.startsAt as string) : now,
      endsAt: new Date(b.endsAt as string),
      push: !!b.push,
    };
  };

  // The home screen: the strip and "À la une", what's for this student (their campus, UFR, region) or for everyone.
  app.get('/alerts', { preHandler: requireAuth, schema: { tags, response: { 200: Type.Object({ items: Type.Array(AlertView) }) } } }, async (req) => ({
    items: (await service.active(await audienceOf(actorOf(req).userId), toObjectId(actorOf(req).userId))).map(alertView),
  }));

  app.get('/admin/alerts', { ...editor, schema: { tags, response: { 200: Type.Object({ items: Type.Array(AdminAlertView) }) } } }, async (req) => {
    const e = await who(req);
    return { items: (await service.recent()).map((a) => service.adminView(a, e)) };
  });

  app.post(
    '/admin/alerts',
    {
      ...editor,
      schema: {
        tags,
        body: Type.Object(
          { ...Fields, kind: Type.Optional(Type.Enum(['campus', 'academic'] as const, { description: 'Default: academic for the academic team, else campus.' })) },
          { additionalProperties: false },
        ),
        response: { 201: AdminAlertView },
      },
    },
    async (req, reply) => {
      const e = await who(req);
      const kind = req.body.kind ?? (e.roles.includes('admin') || e.roles.includes('content_editor') ? 'campus' : 'academic');
      const doc = await service.create({ kind, ...input(req.body, service.now()) }, e);
      await trace(req, 'alert.create', doc._id.toHexString(), { placement: doc.placement, push: doc.push });
      return reply.status(201).send(service.adminView(doc, e));
    },
  );

  app.put(
    '/admin/alerts/:id',
    { ...editor, schema: { tags, params: IdParams, body: Type.Object(Fields, { additionalProperties: false }), response: { 200: AdminAlertView } } },
    async (req) => {
      const e = await who(req);
      const doc = await service.update(toObjectId(req.params.id), input(req.body, service.now()), e);
      await trace(req, 'alert.update', req.params.id);
      return service.adminView(doc, e);
    },
  );

  app.delete('/admin/alerts/:id', { ...editor, schema: { tags, params: IdParams, response: { 200: AdminAlertView } } }, async (req) => {
    const e = await who(req);
    const doc = await service.withdraw(toObjectId(req.params.id), e);
    await trace(req, 'alert.withdraw', req.params.id);
    return service.adminView(doc, e);
  });
}
