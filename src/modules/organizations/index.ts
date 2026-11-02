import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db, ObjectId } from 'mongodb';

import { actorOf } from '../../platform/auth/auth.js';
import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import { toObjectId } from '../../platform/http/schemas.js';
import type { AccountsApi, OrganizationsPort } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import { organizationsCollections, organizationsMigrations } from './organizations.collections.js';
import { registerOrganizationsRoutes } from './organizations.routes.js';
import { OrganizationsService, type CreateOrgInput } from './organizations.service.js';
import type { OrgCapability, OrgRole } from './organizations.types.js';

export { organizationsCollections, organizationsMigrations };
export type { OrgCapability, OrgRole, OrgLevel, OrgCategory } from './organizations.types.js';
export type { OrgCard } from './organizations.service.js';

export type OrganizationsApi = OrganizationsPort & {
  /** Guard for /org/:orgId/... routes: 404 unless the caller holds one of `roles` there (no existence oracle). */
  requireOrgRole(roles: OrgRole[]): preHandlerHookHandler;
  roleIn: OrganizationsService['roleIn'];
  create(input: CreateOrgInput): ReturnType<OrganizationsService['create']>;
  setMember: OrganizationsService['setMember'];
  cards: OrganizationsService['cards'];
  /** Active members and their roles: who to notify (a restaurant's new order), who owns it. */
  members(orgId: ObjectId): Promise<{ userId: ObjectId; roles: OrgRole[] }[]>;
  /** Where an organization's claims are paid; null until an admin sets it. */
  payoutPhone(orgId: ObjectId): Promise<string | null>;
  /** Is the organization active and verified for this (e.g. selling event tickets)? */
  can(orgId: ObjectId, capability: OrgCapability): Promise<boolean>;
  /**
   * A student's own organization (category `Étudiant`), created the first time they organize an event: they own it,
   * its payouts go to their number, and their events go through the admins' review.
   */
  personalOrg(user: { _id: ObjectId; firstName: string; lastName: string; phone: string }, create?: boolean): Promise<ObjectId | null>;
  isPersonal(orgId: ObjectId): Promise<boolean>;
  /** Adds a finished trip to the organizer's count ("128 trajets effectués"). */
  countTrip(orgId: ObjectId): Promise<void>;
  registerRoutes(app: FastifyInstance, requireAdmin: preHandlerHookHandler): void;
};

export function createOrganizationsModule(deps: { db: Db; clock: Clock; accounts: AccountsApi; audit: AuditApi }): OrganizationsApi {
  const service = new OrganizationsService(deps.db, deps.clock, deps.accounts);

  const requireOrgRole = (roles: OrgRole[]): preHandlerHookHandler => async (req) => {
    const orgId = (req.params as { orgId?: string }).orgId;
    if (!orgId) throw errors.notFound();
    if (!(await service.roleIn(toObjectId(orgId), toObjectId(actorOf(req).userId), roles))) throw errors.notFound();
  };

  return {
    membershipsForUser: (userId) => service.membershipsForUser(userId),
    roleIn: (o, u, r) => service.roleIn(o, u, r),
    create: (i) => service.create(i),
    setMember: (o, i, g) => service.setMember(o, i, g),
    cards: (ids) => service.cards(ids),
    members: async (orgId) => (await deps.db.collection('memberships').find({ orgId, status: 'active' }, { projection: { userId: 1, roles: 1 } }).toArray()).map((m) => ({ userId: m.userId, roles: m.roles })),
    payoutPhone: async (orgId) => (await service.get(orgId)).payoutAccount?.phone ?? null,
    personalOrg: async (user, create = true) => {
      const slug = `etudiant-${user._id.toHexString()}`;
      const existing = await deps.db.collection('organizations').findOne({ slug }, { projection: { _id: 1 } });
      if (existing || !create) return existing?._id ?? null;
      const org = await service.create({ slug, name: `${user.firstName} ${user.lastName}`, category: 'Étudiant', capabilities: [], level: 'nouveau', payoutPhone: user.phone }).catch(async (err) => {
        // Created at the same moment by another request.
        const again = await deps.db.collection('organizations').findOne({ slug }, { projection: { _id: 1 } });
        if (again) return { _id: again._id };
        throw err;
      });
      await service.setMember(org._id, { phone: user.phone, roles: ['owner'] }, null);
      return org._id;
    },
    isPersonal: async (orgId) => (await service.get(orgId).catch(() => null))?.category === 'Étudiant',
    can: async (orgId, capability) => {
      const o = await service.get(orgId).catch(() => null);
      return !!o && o.status === 'active' && o.capabilities.includes(capability);
    },
    countTrip: (orgId) => service.countTrip(orgId),
    requireOrgRole,
    registerRoutes: (app, requireAdmin) => registerOrganizationsRoutes(app, { service, audit: deps.audit, requireAdmin, requireOrgRole }),
  };
}
