import type { ObjectId } from 'mongodb';

import type { ImageRef } from '../../platform/media.js';

/** Found something, or lost it. */
export const LOST_STATUSES = ['found', 'lost'] as const;
export type LostStatus = (typeof LOST_STATUSES)[number];

/**
 * Cards are never photographed (name, face and number would be public). A found student card goes through the
 * card flow (OCR, number or name), which warns its owner directly.
 */
export const LOST_KINDS = ['object', 'student-card', 'id-card'] as const;
export type LostKind = (typeof LOST_KINDS)[number];

/** The app's categories (icons and hints live in the app). */
export const LOST_CATEGORIES = ['student-card', 'id-card', 'bank-card', 'phone', 'keys', 'bag', 'wallet', 'earphones', 'glasses', 'clothes', 'calculator', 'other'] as const;
export type LostCategory = (typeof LOST_CATEGORIES)[number];

export const LOST_WHEN = ['today', 'yesterday', 'this_week'] as const;
export type LostWhen = (typeof LOST_WHEN)[number];

/** Found items: dropped at the lost and found office, or kept by the finder until they meet the owner. */
export const LOST_HOLDERS = ['office', 'finder'] as const;
export type LostHolder = (typeof LOST_HOLDERS)[number];

export const LOST_STATES = ['open', 'returned'] as const;
export type LostState = (typeof LOST_STATES)[number];

/** "Moussa S.": how someone appears to other students. Never the full name, the number or the phone. */
export type Masked = { name: string; initials: string };

export type LostItemDoc = {
  _id: ObjectId;
  status: LostStatus;
  kind: LostKind;
  category: LostCategory;
  name: string;
  /** Public: color, brand… */
  details: string | null;
  /** Found objects: a detail only the declarer sees, to check whoever says it's theirs. */
  secret: string | null;
  where: string;
  spot: string | null;
  when: LostWhen;
  /** Found items only. */
  holder: LostHolder | null;
  /** Objects only; required when found. */
  photo: ImageRef | null;
  declaredBy: ObjectId;
  declarer: Masked;
  /**
   * Cards: who it belongs to. A student card matched by its number or name has the owner's account (warned, and
   * can close it); an identity card only the name the finder read ("Mariama S.").
   */
  owner: { userId: ObjectId | null; name: string } | null;
  ownerNotifiedAt: Date | null;
  state: LostState;
  returnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A conversation about an item between its declarer and one other student: someone who says a found item is theirs
 * (`claim`), someone who found a lost item (`found_it`), or the owner of a student card someone found (`card`).
 */
export const CLAIM_ROLES = ['claim', 'found_it', 'card'] as const;
export type ClaimRole = (typeof CLAIM_ROLES)[number];

export type LostClaimDoc = {
  _id: ObjectId;
  itemId: ObjectId;
  declarerId: ObjectId;
  otherId: ObjectId;
  role: ClaimRole;
  /** `claim`: the detail given to prove it. */
  proof: string | null;
  createdAt: Date;
};

/** A found student card stays on the owner's home screen this long (or until they close it). */
export const CARD_ALERT_DAYS = 7;
/** Returned items stay listed (greyed) this long. */
export const RETURNED_VISIBLE_DAYS = 7;
