import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { errors } from '../../platform/http/errors.js';
import { IdParams, ObjectIdString, PhoneInput, toObjectId } from '../../platform/http/schemas.js';
import type { AuditApi } from '../audit/index.js';
import { orgView, type OrganizationsService } from './organizations.service.js';
import { ORG_CAPABILITIES, ORG_CATEGORIES, ORG_LEVELS, ORG_ROLES, type OrgRole } from './organizations.types.js';


const OrgView = Type.Object({
  id: Type.String(), slug: Type.String(), name: Type.String(), category: Type.String(), capabilities: Type.Array(Type.String()),
  level: Type.String(), rating: Type.Union([Type.Number(), Type.Null()]), trips: Type.Number(), status: Type.String(), hasPayoutAccount: Type.Boolean(),
  email: Type.Union([Type.String(), Type.Null()]), logoUrl: Type.Union([Type.String(), Type.Null()]),
});
const EmailInput = Type.String({ minLength: 3, maxLength: 254 });
const OrgParams = Type.Object({ orgId: ObjectIdString }, { additionalProperties: false });
const MemberParams = Type.Object({ id: ObjectIdString, userId: ObjectIdString }, { additionalProperties: false });
const OrgMemberParams = Type.Object({ orgId: ObjectIdString, userId: ObjectIdString }, { additionalProperties: false });
const MemberBody = Type.Object(
  {
    phone: PhoneInput,
    roles: Type.Array(Type.Enum(ORG_ROLES), { minItems: 1, maxItems: 4 }),
    firstName: Type.Optional(Type.String({ minLength: 2, maxLength: 40, description: 'With lastName: creates the account of a new number.' })),
    lastName: Type.Optional(Type.String({ minLength: 2, maxLength: 40 })),
  },
  { additionalProperties: false },
);
const Members = Type.Array(Type.Object({ userId: Type.String(), roles: Type.Array(Type.String()), firstName: Type.String(), lastName: Type.String() }));

type Deps = {
  service: OrganizationsService;
  audit: AuditApi;
  requireAdmin: preHandlerHookHandler;
  requireOrgRole: (roles: OrgRole[]) => preHandlerHookHandler;
};

export function registerOrganizationsRoutes(root: FastifyInstance, { service, audit, requireAdmin, requireOrgRole }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const admin = { preHandler: [requireAuth, requireAdmin] };
  const trail = (req: { id: string; actor: { userId: string } | null }, action: string, id: string, metadata?: Record<string, unknown>) =>
    audit.record({ actor: { type: 'user', id: req.actor?.userId }, action, target: { type: 'organization', id }, requestId: req.id, metadata });

  // ---- Organizer space -------------------------------------------------------------------------------------

  app.get(
    '/org/:orgId',
    { preHandler: [requireAuth, requireOrgRole([...ORG_ROLES])], schema: { tags: ['organizer'], params: OrgParams, response: { 200: Type.Object({ organization: OrgView, myRoles: Type.Array(Type.String()) }) } } },
    async (req) => {
      const org = await service.get(toObjectId(req.params.orgId));
      const roles = (await service.roleIn(org._id, toObjectId(actorOf(req).userId), [...ORG_ROLES])) ?? [];
      return { organization: orgView(org), myRoles: roles };
    },
  );

  // The owner keeps the organization's contact details up to date (logo: once the media module ships).
  app.patch(
    '/org/:orgId',
    {
      preHandler: [requireAuth, requireOrgRole(['owner'])],
      schema: { tags: ['organizer'], params: OrgParams, body: Type.Object({ email: Type.Union([EmailInput, Type.Null()]) }, { additionalProperties: false }), response: { 200: OrgView } },
    },
    async (req) => {
      const org = await service.update(toObjectId(req.params.orgId), { email: req.body.email });
      await trail(req, 'organization.update', req.params.orgId, { fields: ['email'] });
      return orgView(org);
    },
  );

  // Team ("Mon équipe" stays a placeholder in the app; the owner manages it through the API).
  app.get('/org/:orgId/members', { preHandler: [requireAuth, requireOrgRole(['owner'])], schema: { tags: ['organizer'], params: OrgParams, response: { 200: Members } } }, async (req) =>
    service.listMembers(toObjectId(req.params.orgId)),
  );

  app.put('/org/:orgId/members', { preHandler: [requireAuth, requireOrgRole(['owner'])], schema: { tags: ['organizer'], params: OrgParams, body: MemberBody } }, async (req, reply) => {
    // Owners grant staff roles; only platform admins grant `owner`.
    if (req.body.roles.includes('owner')) throw errors.forbidden('Seul un administrateur peut nommer un propriétaire.');
    const orgId = toObjectId(req.params.orgId);
    const res = await service.setMember(orgId, req.body, toObjectId(actorOf(req).userId));
    await trail(req, 'membership.set', req.params.orgId, { userId: res.userId.toHexString(), roles: res.roles });
    return reply.status(204).send();
  });

  app.delete('/org/:orgId/members/:userId', { preHandler: [requireAuth, requireOrgRole(['owner'])], schema: { tags: ['organizer'], params: OrgMemberParams } }, async (req, reply) => {
    await service.revokeMember(toObjectId(req.params.orgId), toObjectId(req.params.userId));
    await trail(req, 'membership.revoke', req.params.orgId, { userId: req.params.userId });
    return reply.status(204).send();
  });

  // ---- Admin (onboarding while there is no web platform, decision Q-12) -----------------------------------------

  app.get('/admin/organizations', { ...admin, schema: { tags: ['admin'], response: { 200: Type.Array(OrgView) } } }, async () => (await service.list()).map(orgView));

  app.post(
    '/admin/organizations',
    {
      ...admin,
      schema: {
        tags: ['admin'],
        body: Type.Object(
          {
            slug: Type.String({ pattern: '^[a-z0-9-]{2,60}$' }),
            name: Type.String({ minLength: 2, maxLength: 80 }),
            category: Type.Enum(ORG_CATEGORIES),
            capabilities: Type.Array(Type.Enum(ORG_CAPABILITIES), { minItems: 1 }),
            level: Type.Optional(Type.Enum(ORG_LEVELS)),
            payoutPhone: Type.Optional(PhoneInput),
            email: Type.Optional(EmailInput),
          },
          { additionalProperties: false },
        ),
        response: { 201: OrgView },
      },
    },
    async (req, reply) => {
      const org = await service.create(req.body);
      await trail(req, 'organization.create', org._id.toHexString());
      return reply.status(201).send(orgView(org));
    },
  );

  app.patch(
    '/admin/organizations/:id',
    {
      ...admin,
      schema: {
        tags: ['admin'],
        params: IdParams,
        body: Type.Object(
          {
            name: Type.Optional(Type.String({ minLength: 2, maxLength: 80 })),
            level: Type.Optional(Type.Enum(ORG_LEVELS)),
            status: Type.Optional(Type.Enum(['pending', 'active', 'suspended'] as const)),
            payoutPhone: Type.Optional(Type.Union([PhoneInput, Type.Null()])),
            email: Type.Optional(Type.Union([EmailInput, Type.Null()])),
          },
          { additionalProperties: false },
        ),
        response: { 200: OrgView },
      },
    },
    async (req) => {
      const org = await service.update(toObjectId(req.params.id), req.body);
      await trail(req, 'organization.update', req.params.id, { fields: Object.keys(req.body) });
      return orgView(org);
    },
  );

  app.put('/admin/organizations/:id/members', { ...admin, schema: { tags: ['admin'], params: IdParams, body: MemberBody } }, async (req, reply) => {
    const res = await service.setMember(toObjectId(req.params.id), req.body, toObjectId(actorOf(req).userId));
    await trail(req, 'membership.set', req.params.id, { userId: res.userId.toHexString(), roles: res.roles });
    return reply.status(204).send();
  });

  app.delete('/admin/organizations/:id/members/:userId', { ...admin, schema: { tags: ['admin'], params: MemberParams } }, async (req, reply) => {
    await service.revokeMember(toObjectId(req.params.id), toObjectId(req.params.userId));
    await trail(req, 'membership.revoke', req.params.id, { userId: req.params.userId });
    return reply.status(204).send();
  });
}
