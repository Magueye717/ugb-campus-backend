import type { ObjectId } from 'mongodb';

import type { ImageRef } from '../../platform/media.js';
import type { Campus } from '../accounts/index.js';
import type { PaymentMethod } from '../payments/index.js';

/** A private restaurant (menus, drinks) or a shop (articles), run by an organization with that capability. */
export const BUSINESS_KINDS = ['restaurant', 'shop'] as const;
export type BusinessKind = (typeof BUSINESS_KINDS)[number];

/** "13:00" to "15:00": the same every day. Several services: lunch and dinner. */
export type Service = { start: string; end: string };

/**
 * What students see of the business, set by an admin at creation then by its owner or managers: picture, where it is
 * (GPS point for directions, words, campus), contact, opening hours, delivery.
 */
export type BusinessDoc = {
  _id: ObjectId;
  /** The organization (members, payout number). One business per organization. */
  orgId: ObjectId;
  kind: BusinessKind;
  name: string;
  /** "Sénégalais", "Grillades", "Papeterie", "Téléphonie". */
  specialty: string;
  description: string;
  photo: ImageRef | null;
  location: { lat: number; lng: number } | null;
  /** In words students use: "Près du Village E". */
  address: string;
  campus: Campus | null;
  phone: string;
  services: Service[];
  /** Fee in FCFA (0: free); null: no delivery, pickup only. */
  deliveryFee: number | null;
  /** The owner can pause orders (closed today, out of stock) without touching the hours. */
  acceptingOrders: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** Restaurants: menus of the day and drinks. Shops: articles (with a category of their own). */
export const ITEM_SECTIONS = ['menu', 'drink', 'article'] as const;
export type ItemSection = (typeof ITEM_SECTIONS)[number];

export type CatalogItemDoc = {
  _id: ObjectId;
  businessId: ObjectId;
  section: ItemSection;
  /** Shops: "Fournitures", "Accessoires"… (free text, groups the articles). */
  category: string | null;
  name: string;
  detail: string;
  price: number;
  photo: ImageRef | null;
  /** Shops: units left (orders take them, refusals give them back); null: not counted. */
  stock: number | null;
  /** Shown and orderable today. */
  available: boolean;
  sortOrder: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * pending_payment → placed (paid: the business is notified) → accepted (being prepared) → ready (on its way, or to
 * pick up) → completed (paid out to the business). The business can refuse a placed order and the student can cancel
 * it before it's accepted: refunded either way. Unpaid: expired.
 */
export const ORDER_STATUSES = ['pending_payment', 'placed', 'accepted', 'ready', 'completed', 'refused', 'cancelled', 'expired'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_MODES = ['delivery', 'pickup'] as const;
export type OrderMode = (typeof ORDER_MODES)[number];

export type OrderLine = { itemId: ObjectId; name: string; price: number; qty: number };

export type OrderDoc = {
  _id: ObjectId;
  /** Short, said at the counter: "C7KQ2M". */
  code: string;
  businessId: ObjectId;
  orgId: ObjectId;
  userId: ObjectId;
  lines: OrderLine[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  mode: OrderMode;
  address: string | null;
  note: string | null;
  method: PaymentMethod;
  paymentId: ObjectId | null;
  status: OrderStatus;
  /** Every step, oldest first. */
  history: { status: OrderStatus; at: Date; by: ObjectId | null }[];
  refusal: string | null;
  payoutId: ObjectId | null;
  refundPayoutId: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Time to pay before the order (and the stock it holds) goes back. */
export const ORDER_PAY_WITHIN_MIN = 15;
/** Orders still in the business's hands after this are completed by the worker (and paid out). */
export const ORDER_AUTO_COMPLETE_H = 12;
