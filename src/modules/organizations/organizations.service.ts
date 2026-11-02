import { ObjectId, type Collection, type Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import { normalizeEmail } from '../../platform/email.js';
import { normalizePhone } from '../../platform/phone.js';
import type { AccountsApi, MembershipSummary } from '../accounts/index.js';
import type { MembershipDoc, OrgCapability, OrgCategory, OrgLevel, OrgRole, OrganizationDoc } from './organizations.types.js';

export type CreateOrgInput = { slug: string; name: string; category: OrgCategory; capabilities: OrgCapability[]; level?: OrgLevel; payoutPhone?: string; email?: string };
export type UpdateOrgInput = Partial<{ name: string; level: OrgLevel; status: OrganizationDoc['status']; payoutPhone: string | null; email: string | null }>;

export class OrganizationsService {
  private readonly orgs: Collection<OrganizationDoc>;
  private readonly members: Collection<MembershipDoc>;

  constructor(
    db: Db,
    private readonly clock: Clock,
    private readonly accounts: AccountsApi,
  ) {
    this.orgs = db.collection<OrganizationDoc>('organizations');
    this.members = db.collection<MembershipDoc>('memberships');
  }

  private payout(phone: string | null | undefined) {
    if (!phone) return null;
    const p = normalizePhone(phone);
    if (!p) throw errors.validation('Numéro de paiement invalide.', { field: 'payoutPhone' });
    return { phone: p };
  }

  private email(input: string | null | undefined) {
    if (!input) return null;
    const v = normalizeEmail(input);
    if (!v) throw errors.validation('Adresse e-mail invalide.', { field: 'email' });
    return v;
  }

  async create(input: CreateOrgInput): Promise<OrganizationDoc> {
    const now = this.clock.now();
    const doc: OrganizationDoc = {
      _id: new ObjectId(),
      slug: input.slug,
      name: input.name.trim(),
      category: input.category,
      capabilities: [...new Set(input.capabilities)],
      level: input.level ?? 'nouveau',
      stats: { ratingAvg: null, ratingCount: 0, tripsCount: 0 },
      status: 'active',
      payoutAccount: this.payout(input.payoutPhone),
      email: this.email(input.email),
      logo: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.orgs.insertOne(doc);
    } catch (err) {
      if (isDuplicateKey(err, 'slug_unique')) throw errors.conflict('SLUG_TAKEN', 'Cet identifiant est déjà utilisé.');
      throw err;
    }
    return doc;
  }

  async update(id: ObjectId, input: UpdateOrgInput) {
    const $set: Partial<OrganizationDoc> = { updatedAt: this.clock.now() };
    if (input.name !== undefined) $set.name = input.name.trim();
    if (input.level !== undefined) $set.level = input.level;
    if (input.status !== undefined) $set.status = input.status;
    if (input.payoutPhone !== undefined) $set.payoutAccount = this.payout(input.payoutPhone);
    if (input.email !== undefined) $set.email = this.email(input.email);
    const doc = await this.orgs.findOneAndUpdate({ _id: id }, { $set }, { returnDocument: 'after' });
    if (!doc) throw errors.notFound();
    return doc;
  }

  list() {
    return this.orgs.find({}).sort({ name: 1 }).limit(500).toArray();
  }

  async get(id: ObjectId) {
    const doc = await this.orgs.findOne({ _id: id });
    if (!doc) throw errors.notFound();
    return doc;
  }

  async countTrip(orgId: ObjectId) {
    await this.orgs.updateOne({ _id: orgId }, { $inc: { 'stats.tripsCount': 1 }, $set: { updatedAt: this.clock.now() } });
  }

  /** Public cards of several organizations (listings show who runs each departure). */
  async cards(ids: ObjectId[]): Promise<Map<string, OrgCard>> {
    const docs = ids.length ? await this.orgs.find({ _id: { $in: ids } }).toArray() : [];
    return new Map(docs.map((o) => [o._id.toHexString(), orgCard(o)]));
  }

  /**
   * Grants roles to an account (by phone). Re-granting replaces the roles and reactivates. A new number gets an
   * account when a name is given (a restaurant's new employee): they set their password with "mot de passe oublié".
   */
  async setMember(orgId: ObjectId, input: { phone: string; roles: OrgRole[]; firstName?: string; lastName?: string }, grantedBy: ObjectId | null) {
    await this.get(orgId);
    const phone = this.accounts.phoneOrThrow(input.phone);
    let user = await this.accounts.findByPhone(phone);
    if (!user && input.firstName && input.lastName) user = await this.accounts.createStaffUser({ phone, firstName: input.firstName, lastName: input.lastName });
    if (!user) throw errors.rule('USER_NOT_FOUND', 'Aucun compte avec ce numéro : ajoute son prénom et son nom pour le créer.');
    const now = this.clock.now();
    const roles = [...new Set(input.roles)];
    await this.members.updateOne(
      { orgId, userId: user._id },
      { $set: { roles, status: 'active', grantedBy, updatedAt: now }, $setOnInsert: { _id: new ObjectId(), createdAt: now } },
      { upsert: true },
    );
    return { userId: user._id, roles };
  }

  async revokeMember(orgId: ObjectId, userId: ObjectId) {
    const res = await this.members.updateOne({ orgId, userId, status: 'active' }, { $set: { status: 'revoked', updatedAt: this.clock.now() } });
    if (res.matchedCount === 0) throw errors.notFound();
  }

  async listMembers(orgId: ObjectId) {
    const list = await this.members.find({ orgId, status: 'active' }).toArray();
    const users = await Promise.all(list.map((m) => this.accounts.findById(m.userId)));
    return list.map((m, i) => ({ userId: m.userId.toHexString(), roles: m.roles, firstName: users[i]?.firstName ?? '', lastName: users[i]?.lastName ?? '' }));
  }

  async membershipsForUser(userId: ObjectId): Promise<MembershipSummary[]> {
    const list = await this.members.find({ userId, status: 'active' }).toArray();
    if (!list.length) return [];
    const orgs = await this.orgs.find({ _id: { $in: list.map((m) => m.orgId) }, status: 'active' }).toArray();
    const byId = new Map(orgs.map((o) => [o._id.toHexString(), o]));
    return list.flatMap((m) => {
      const o = byId.get(m.orgId.toHexString());
      return o ? [{ orgId: o._id.toHexString(), name: o.name, category: o.category, level: o.level, roles: m.roles, capabilities: o.capabilities }] : [];
    });
  }

  /** Active membership of an active organization with one of `roles` (owner can do everything). Null otherwise. */
  async roleIn(orgId: ObjectId, userId: ObjectId, roles: OrgRole[]): Promise<OrgRole[] | null> {
    const m = await this.members.findOne({ orgId, userId, status: 'active' });
    if (!m) return null;
    const org = await this.orgs.findOne({ _id: orgId, status: 'active' }, { projection: { _id: 1 } });
    if (!org) return null;
    return m.roles.includes('owner') || m.roles.some((r) => roles.includes(r)) ? m.roles : null;
  }
}

export function orgView(o: OrganizationDoc) {
  return {
    id: o._id.toHexString(),
    slug: o.slug,
    name: o.name,
    category: o.category,
    capabilities: o.capabilities,
    level: o.level,
    rating: o.stats.ratingAvg,
    trips: o.stats.tripsCount,
    status: o.status,
    hasPayoutAccount: !!o.payoutAccount,
    email: o.email,
    /** Null until the media module ships (logo upload). */
    logoUrl: o.logo?.url ?? null,
  };
}

/** What students see of an organizer: no contact details, no payout account. */
export type OrgCard = { id: string; slug: string; name: string; category: OrganizationDoc['category']; level: OrganizationDoc['level']; rating: number | null; trips: number; logoUrl: string | null };
export const orgCard = (o: OrganizationDoc): OrgCard => ({
  id: o._id.toHexString(),
  slug: o.slug,
  name: o.name,
  category: o.category,
  level: o.level,
  rating: o.stats.ratingAvg,
  trips: o.stats.tripsCount,
  logoUrl: o.logo?.url ?? null,
});
