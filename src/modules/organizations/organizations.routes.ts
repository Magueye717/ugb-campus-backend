import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { errors } from '../../platform/http/errors.js';
import { IdParams, ObjectIdString, PhoneInput, toObjectId } from '../../platform/http/schemas.js';
import type { AuditApi } from '../audit/index.js';
import { orgView, ROLE_LABELS, SPACE_ROLES, type OrganizationsService } from './organizations.service.js';
import { ORG_CAPABILITIES, ORG_CATEGORIES, ORG_LEVELS, ORG_ROLES, ORG_SPACES, type OrgRole, type OrgSpace } from './organizations.types.js';


const OrgView = Type.Object({
  id: Type.String(), slug: Type.String(), name: Type.String(), category: Type.String(), capabilities: Type.Array(Type.String()),
  level: Type.String(), rating: Type.Union([Type.Number(), Type.Null()]), trips: Type.Number(), status: Type.String(), hasPayoutAccount: Type.Boolean(),
  email: Type.Union([Type.String(), Type.Null()]), logoUrl: Type.Union([Type.String(), Type.Null()]),
});
const EmailInput = Type.String({ minLength: 3, maxLength: 254 });
const OrgParams = Type.Object({ orgId: ObjectIdString }, { additionalProperties: false });
const MemberParams = Type.Object({ id: ObjectIdString, userId: ObjectIdString }, { additionalProperties: false });
const SpaceParams = Type.Object({ orgId: ObjectIdString, space: Type.Enum(ORG_SPACES) }, { additionalProperties: false });
const SpaceMemberParams = Type.Object({ orgId: ObjectIdString, space: Type.Enum(ORG_SPACES), userId: ObjectIdString }, { additionalProperties: false });
const MemberBody = Type.Object(
  {
    phone: PhoneInput,
    roles: Type.Array(Type.Enum(ORG_ROLES), { minItems: 1, maxItems: 4 }),
    firstName: Type.Optional(Type.String({ minLength: 2, maxLength: 40, description: 'With lastName and password: creates the account of a new number.' })),
    lastName: Type.Optional(Type.String({ minLength: 2, maxLength: 40 })),
    password: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
const AdminMemberBody = Type.Object({ ...MemberBody.properties, space: Type.Optional(Type.Enum(ORG_SPACES, { description: 'Not needed to name an owner (every space).' })) }, { additionalProperties: false });
const Members = Type.Object({
  items: Type.Array(Type.Object({ userId: Type.String(), roles: Type.Array(Type.String()), firstName: Type.String(), lastName: Type.String() })),
  /** What the owner can give in this space, with the labels to show. */
  roles: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })),
});
const Assignment = Type.Object({ space: Type.Enum(ORG_SPACES), roles: Type.Array(Type.Enum(ORG_ROLES), { maxItems: 4 }) }, { additionalProperties: false });
const Lookup = Type.Union([
  Type.Object({ exists: Type.Literal(true), firstName: Type.String(), lastName: Type.String(), assignments: Type.Array(Assignment) }),
  Type.Object({ exists: Type.Literal(false) }),
]);
const RoleOption = Type.Object({ value: Type.String(), label: Type.String() });
const Team = Type.Object({
  spaces: Type.Array(Type.Object({ space: Type.String(), label: Type.String(), roles: Type.Array(RoleOption) })),
  members: Type.Array(
    Type.Object({
      userId: Type.String(), firstName: Type.String(), lastName: Type.String(), owner: Type.Boolean(),
      spaces: Type.Array(Type.Object({ space: Type.String(), label: Type.String(), roles: Type.Array(RoleOption) })),
    }),
  ),
});
const TeamParams = Type.Object({ orgId: ObjectIdString, userId: ObjectIdString, space: Type.Enum(ORG_SPACES), role: Type.Enum(ORG_ROLES) }, { additionalProperties: false });

type Deps = {
  service: OrganizationsService;
  audit: AuditApi;
  requireAdmin: preHandlerHookHandler;
  requireOrgRole: (roles: OrgRole[], space?: OrgSpace | 'param') => preHandlerHookHandler;
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

  // Team of one space ("Mon équipe"): only its owner sees and manages it.
  const owners = { preHandler: [requireAuth, requireOrgRole(['owner'], 'param')] };
  app.get('/org/:orgId/:space/members', { ...owners, schema: { tags: ['organizer'], params: SpaceParams, response: { 200: Members } } }, async (req) => ({
    items: await service.listMembers(toObjectId(req.params.orgId), req.params.space),
    roles: SPACE_ROLES[req.params.space].map((r) => ({ value: r, label: ROLE_LABELS[r] })),
  }));

  // Adding someone, step 1: is the number already on UGB Campus? (Then step 2 only asks for the role.)
  app.post(
    '/org/:orgId/members/lookup',
    { preHandler: [requireAuth, requireOrgRole(['owner'])], schema: { tags: ['organizer'], params: OrgParams, body: Type.Object({ phone: PhoneInput }, { additionalProperties: false }), response: { 200: Lookup } } },
    async (req) => service.lookup(req.body.phone, toObjectId(req.params.orgId)),
  );

  // "Mon équipe" of the whole entity: everyone once, with their roles space by space (restaurant, shop, organizer).
  const entityOwner = { preHandler: [requireAuth, requireOrgRole(['owner'])] };
  app.get('/org/:orgId/team', { ...entityOwner, schema: { tags: ['organizer'], params: OrgParams, response: { 200: Team } } }, async (req) => service.team(toObjectId(req.params.orgId)));

  app.put(
    '/org/:orgId/team',
    {
      ...entityOwner,
      schema: {
        tags: ['organizer'],
        params: OrgParams,
        description: 'Someone’s roles in every space of the entity at once (a space without roles is taken away). By phone (step 2 after lookup; a new number needs a name and a password) or by userId (a member).',
        body: Type.Object(
          {
            phone: Type.Optional(PhoneInput),
            userId: Type.Optional(ObjectIdString),
            firstName: Type.Optional(Type.String({ minLength: 2, maxLength: 40 })),
            lastName: Type.Optional(Type.String({ minLength: 2, maxLength: 40 })),
            password: Type.Optional(Type.String({ maxLength: 128 })),
            assignments: Type.Array(Assignment, { minItems: 1, maxItems: ORG_SPACES.length }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      if (!req.body.phone === !req.body.userId) throw errors.validation('Un numéro ou un membre.', { field: 'phone' });
      const res = await service.setTeamMember(toObjectId(req.params.orgId), { ...req.body, userId: req.body.userId ? toObjectId(req.body.userId) : undefined }, toObjectId(actorOf(req).userId));
      await trail(req, 'membership.team', req.params.orgId, { userId: res.userId.toHexString(), assignments: res.assignments, created: res.created });
      return reply.status(204).send();
    },
  );

  app.delete(
    '/org/:orgId/team/:userId',
    { ...entityOwner, schema: { tags: ['organizer'], params: Type.Object({ orgId: ObjectIdString, userId: ObjectIdString }, { additionalProperties: false }), description: 'Out of every space of the entity.' } },
    async (req, reply) => {
      await service.removeFromTeam(toObjectId(req.params.orgId), toObjectId(req.params.userId));
      await trail(req, 'membership.team_removed', req.params.orgId, { userId: req.params.userId });
      return reply.status(204).send();
    },
  );

  app.delete('/org/:orgId/team/:userId/:space/:role', { ...entityOwner, schema: { tags: ['organizer'], params: TeamParams, description: 'One role taken away; the others stay.' } }, async (req, reply) => {
    await service.removeRole(toObjectId(req.params.orgId), toObjectId(req.params.userId), req.params.space, req.params.role);
    await trail(req, 'membership.role_removed', req.params.orgId, { userId: req.params.userId, space: req.params.space, role: req.params.role });
    return reply.status(204).send();
  });

  app.put('/org/:orgId/:space/members', { ...owners, schema: { tags: ['organizer'], params: SpaceParams, body: MemberBody } }, async (req, reply) => {
    // Owners give the space's roles; only platform admins name an owner.
    if (req.body.roles.some((r) => !SPACE_ROLES[req.params.space].includes(r))) throw errors.forbidden('Ce rôle n’existe pas dans cet espace.');
    const orgId = toObjectId(req.params.orgId);
    const res = await service.setMember(orgId, req.params.space, req.body, toObjectId(actorOf(req).userId));
    await trail(req, 'membership.set', req.params.orgId, { userId: res.userId.toHexString(), roles: res.roles, space: req.params.space, created: res.created });
    return reply.status(204).send();
  });

  app.delete('/org/:orgId/:space/members/:userId', { ...owners, schema: { tags: ['organizer'], params: SpaceMemberParams } }, async (req, reply) => {
    await service.revokeMember(toObjectId(req.params.orgId), req.params.space, toObjectId(req.params.userId));
    await trail(req, 'membership.revoke', req.params.orgId, { userId: req.params.userId, space: req.params.space });
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

  // Admins name owners (every space) or add someone to one space.
  app.put('/admin/organizations/:id/members', { ...admin, schema: { tags: ['admin'], params: IdParams, body: AdminMemberBody } }, async (req, reply) => {
    const orgId = toObjectId(req.params.id);
    const by = toObjectId(actorOf(req).userId);
    const { space, ...member } = req.body;
    if (member.roles.includes('owner')) {
      const userId = await service.setOwner(orgId, member.phone, by);
      await trail(req, 'membership.owner', req.params.id, { userId: userId.toHexString() });
    } else {
      if (!space) throw errors.validation('Indique l’espace.', { field: 'space' });
      const res = await service.setMember(orgId, space, member, by);
      await trail(req, 'membership.set', req.params.id, { userId: res.userId.toHexString(), roles: res.roles, space });
    }
    return reply.status(204).send();
  });

  app.delete('/admin/organizations/:id/members/:userId', { ...admin, schema: { tags: ['admin'], params: MemberParams, querystring: Type.Object({ space: Type.Enum(ORG_SPACES) }, { additionalProperties: false }) } }, async (req, reply) => {
    await service.revokeMember(toObjectId(req.params.id), req.query.space, toObjectId(req.params.userId));
    await trail(req, 'membership.revoke', req.params.id, { userId: req.params.userId, space: req.query.space });
    return reply.status(204).send();
  });
}
