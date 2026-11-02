import type { ObjectId } from 'mongodb';

import type { Audience } from '../accounts/index.js';

export const ALERT_TONES = ['info', 'warning', 'danger', 'success'] as const;
export type AlertTone = (typeof ALERT_TONES)[number];

/**
 * Who it comes from, which decides who may change it: the communication team (`campus`), the academic team
 * (`academic`: exams, enrolments…), or a feature (`resto_stock`: a dish sold out, follows the stock; `lost_card`:
 * someone found your student card, for you only).
 */
export const ALERT_KINDS = ['campus', 'academic', 'resto_stock', 'lost_card'] as const;
/** Raised and cleared by features, never edited by hand. */
export const FEATURE_KINDS = ['resto_stock', 'lost_card'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Where it shows on the home screen: the strip at the top (short, urgent) or "À la une" (news, announcements). */
export const ALERT_PLACEMENTS = ['banner', 'headline'] as const;
export type AlertPlacement = (typeof ALERT_PLACEMENTS)[number];

/** For the back office: programmée, en ligne, terminée, retirée. */
export type AlertStatus = 'scheduled' | 'live' | 'ended' | 'withdrawn';

/**
 * A notice on the students' home screen ("Coupure d'eau · Village E", "Élections des délégués"), shown between
 * `startsAt` and `endsAt` unless withdrawn. Can be prepared in advance; the push, if asked, leaves when it goes
 * online.
 */
export type AlertDoc = {
  _id: ObjectId;
  kind: AlertKind;
  placement: AlertPlacement;
  /** "À la une" label: "Élections", "Bourses". */
  tag: string | null;
  title: string;
  body: string;
  /** Ionicons name (from an allowlist in the app). */
  icon: string;
  tone: AlertTone;
  /** Screen opened on tap, an app route; null: display only. */
  href: string | null;
  /** The day it's about (the vote, the payment), shown next to the item; null: none. */
  eventAt: Date | null;
  /** Who it's for: campuses, UFRs, home regions (each list narrows; all empty: the whole university). */
  audience: Audience;
  /** A personal alert, for this user only (and never listed in the back office). Missing or null: the audience. */
  forUserId?: ObjectId | null;
  /**
   * Set by the feature that raised it ("public-menu:<menuId>:<dishId>"): unique, so raising the same alert again
   * updates it instead of adding a second one.
   */
  sourceKey: string | null;
  startsAt: Date;
  endsAt: Date;
  /** A push to everyone was asked; `pushedAt` once it left (when the alert went online). */
  push: boolean;
  pushedAt: Date | null;
  withdrawnAt: Date | null;
  createdBy: ObjectId | null;
  updatedBy: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AlertInput = {
  kind: Exclude<AlertKind, (typeof FEATURE_KINDS)[number]>;
  placement: AlertPlacement;
  tag: string | null;
  title: string;
  body: string;
  icon: string;
  tone: AlertTone;
  href: string | null;
  eventAt: Date | null;
  audience: Audience;
  startsAt: Date;
  endsAt: Date;
  push: boolean;
};

/** Raised by a feature: always a banner, never pushed by the alerts module (the feature decides). */
export type RaisedAlert = {
  kind: (typeof FEATURE_KINDS)[number];
  title: string;
  body: string;
  icon: string;
  tone: AlertTone;
  href: string | null;
  audience: Audience;
  forUserId?: ObjectId | null;
  startsAt?: Date;
  endsAt: Date;
};

export const EVERYONE: Audience = { campuses: [], ufrs: [], regions: [] };
