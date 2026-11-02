import type { ObjectId } from 'mongodb';

import type { Audience } from '../accounts/index.js';

/** The app's filters ("Social", "Cours", "Paiements", "Campus": restos, alerts) and the matching switches in the profile. */
export const NOTIFICATION_CATEGORIES = ['social', 'cours', 'paiements', 'campus'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * A view of the bell: `orders` is a restaurant's or shop's space, only the orders it receives (a new one, one cancelled
 * by the client), not the owner's own student notifications.
 */
export const NOTIFICATION_SCOPES = ['orders'] as const;
export type NotificationScope = (typeof NOTIFICATION_SCOPES)[number];
export const SCOPE_TYPES: Record<NotificationScope, string[]> = { orders: ['commerce.order_placed', 'commerce.order_cancelled'] };

/** Semantic tone, not a colour: the app keeps its theme. */
export const NOTIFICATION_TONES = ['primary', 'success', 'warning', 'danger', 'purple'] as const;
export type NotificationTone = (typeof NOTIFICATION_TONES)[number];

/** One line of the in-app list (the bell). */
export type NotificationDoc = {
  _id: ObjectId;
  userId: ObjectId;
  category: NotificationCategory;
  /** What happened, e.g. `ticket.transfer_offered`. */
  type: string;
  title: string;
  /** No sensitive data: no phone numbers, no full names of others. */
  body: string;
  /** Ionicons name (from an allowlist in the app). */
  icon: string;
  tone: NotificationTone;
  /** Screen opened on tap, an app route ("/billet/…"). */
  url: string | null;
  /** The same event never notifies twice (unique per user). */
  dedupeKey: string;
  readAt: Date | null;
  createdAt: Date;
};

/** A phone that receives push notifications. One token = one installation of the app. */
export type PushTokenDoc = {
  _id: ObjectId;
  /** "ExponentPushToken[…]", unique. */
  token: string;
  userId: ObjectId;
  platform: 'ios' | 'android' | 'web';
  /** False once Expo says the app was uninstalled, or on sign-out. */
  active: boolean;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NewNotification = {
  type: string;
  category: NotificationCategory;
  title: string;
  body: string;
  icon: string;
  tone?: NotificationTone;
  url?: string | null;
  /** Per user: `ticket.transfer:<id>`. */
  dedupeKey: string;
  /**
   * False: push only, no line in the list (chat messages: the conversation is the list).
   * Default true.
   */
  persist?: boolean;
  /** Android channel on the phone: `orders` (a shop's new orders: louder, longer vibration). Default: the campus one. */
  channel?: PushChannel;
};

/** The app creates these Android channels (lib/notifications.ts). */
export type PushChannel = 'campus' | 'orders';

/**
 * `audience: 'all'`: every phone with the app (a dish sold out, a campus alert); with `segment`, only the students
 * it targets (a UFR, a campus, a region). `userIds` is then ignored.
 */
export type PushJob = { userIds: string[]; audience?: 'all'; segment?: Audience; title: string; body: string; url: string | null; category: NotificationCategory; collapseId?: string; channel?: PushChannel };

/** `segment`: only these students (see Audience); omitted, everyone with the app. */
export type Broadcast = { title: string; body: string; url: string | null; category: NotificationCategory; dedupeKey: string; segment?: Audience };
