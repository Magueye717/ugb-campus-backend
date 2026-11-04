import type { ObjectId } from 'mongodb';

/** What a student can rate once it's over: a caravan trip, an event they attended, an order they received. */
export const RATING_SUBJECTS = ['caravan', 'event', 'order'] as const;
export type RatingSubject = (typeof RATING_SUBJECTS)[number];

/** Asked for during this long after the end; a rating can still be given (or changed) until `RATE_WITHIN_DAYS`. */
export const ASK_WITHIN_DAYS = 7;
export const RATE_WITHIN_DAYS = 30;
/** "Plus tard" this many times: no more asking (the service's page still offers it). */
export const MAX_PROMPTS = 3;

/**
 * One student's rating of one service (one per student and service). Optional: `stars` null while they haven't rated
 * (postponed or declined). Organizers are rated through their trips and events, restaurants and shops through orders.
 */
export type RatingDoc = {
  _id: ObjectId;
  userId: ObjectId;
  subject: RatingSubject;
  subjectId: ObjectId;
  /** Who is rated: the organization (caravans, events) and, for an order, its business. */
  orgId: ObjectId;
  businessId: ObjectId | null;
  /** 1 to 5; null: not rated. */
  stars: number | null;
  comment: string;
  /** "Plus tard": how many times the question was put off. */
  prompts: number;
  /** "Ne pas noter": never asked again. */
  declined: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** A service that ended, as the rating screen shows it. */
export type Rateable = {
  subject: RatingSubject;
  id: ObjectId;
  orgId: ObjectId;
  businessId: ObjectId | null;
  /** "UGB → Dakar", "Soirée de gala", "Commande chez Khoulé & Frère" (the vendor, never the order code). */
  title: string;
  /** Who is rated: "Sunu Voyage", "Khoulé & Frère". */
  ratedName: string;
  /** "Mer. 03 sept", the end. */
  endedAt: Date;
};
