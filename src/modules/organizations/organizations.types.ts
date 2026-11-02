import type { ObjectId } from 'mongodb';

import type { ImageRef } from '../../platform/media.js';

/** `Étudiant`: a student's own organization, created when they first organize an event (reviewed by admins). */
export const ORG_CATEGORIES = ['Entreprise', 'Amicale', 'Transporteur', 'Restaurant', 'Boutique', 'Étudiant'] as const;
export const ORG_LEVELS = ['nouveau', 'verifie', 'confirme'] as const;
/**
 * What the platform verified the organization for: `events` lets it sell tickets for parties, conferences, outings;
 * `restaurant` and `shop` give it a business space (menus or articles, orders paid in the app).
 */
export const ORG_CAPABILITIES = ['caravans', 'restaurant', 'shop', 'events'] as const;
/** owner: everything incl. team · manager: departures, menus, orders · scanner: boarding only · staff: restaurant orders. */
export const ORG_ROLES = ['owner', 'manager', 'scanner', 'staff'] as const;

export type OrgCategory = (typeof ORG_CATEGORIES)[number];
export type OrgLevel = (typeof ORG_LEVELS)[number];
export type OrgCapability = (typeof ORG_CAPABILITIES)[number];
export type OrgRole = (typeof ORG_ROLES)[number];

export type OrganizationDoc = {
  _id: ObjectId;
  slug: string;
  name: string;
  category: OrgCategory;
  capabilities: OrgCapability[];
  /** Set by an admin until a rating flow exists (Q-22). */
  level: OrgLevel;
  stats: { ratingAvg: number | null; ratingCount: number; tripsCount: number };
  status: 'pending' | 'active' | 'suspended';
  /** Where organizer claims are paid (decision Q-2): a Wave / Orange Money number. */
  payoutAccount: { phone: string } | null;
  /** Contact address, given at creation or later (admin or owner). Not unique: one contact may run several organizations. */
  email: string | null;
  /** Logo or profile picture, set through the media module (never a client-supplied URL). */
  logo: ImageRef | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MembershipDoc = {
  _id: ObjectId;
  orgId: ObjectId;
  userId: ObjectId;
  roles: OrgRole[];
  status: 'active' | 'revoked';
  grantedBy: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};
