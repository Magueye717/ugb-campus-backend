import type { ObjectId } from 'mongodb';

/**
 * Seats lock this long before departure (leaving after that is no longer refunded): chosen by the organizer when
 * proposing the trip, 10 minutes if they skip it.
 */
export const TAXI_LOCK_MIN = 10;
export const TAXI_LOCK_CHOICE = { min: 5, max: 120 } as const;
/** Trips stay listed (and "active" for their people) this long after their time, in case the taxi is late. */
export const TAXI_GRACE_MIN = 15;
/** The trip chat stays open this long after departure. */
export const TAXI_CHAT_HOURS = 2;
/** A student who joins has this long to pay before the seat is released. */
export const TAXI_HOLD_MIN = 10;
/** Late cancellations within 30 days before Sunu Taxi is suspended for 7 days. */
export const TAXI_STRIKES_LIMIT = 3;
export const TAXI_STRIKE_WINDOW_DAYS = 30;
export const TAXI_SUSPENSION_DAYS = 7;

/** Bounds agreed for the form (decision 2026-10-31): seats include the organizer. */
export const TAXI_SEATS = { min: 2, max: 4 } as const;
export const TAXI_FARE = { min: 500, max: 20_000 } as const;
/** How far ahead a trip can be proposed. */
export const TAXI_DEPARTURE = { minMin: 10, maxDays: 7 } as const;

export const TRIP_STATUSES = ['open', 'departed', 'cancelled'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export type TaxiTripDoc = {
  _id: ObjectId;
  organizerUserId: ObjectId;
  /** Free text, as typed in the form ("UGB · Village E"). */
  from: string;
  to: string;
  departureAt: Date;
  /** See lockTime(): 30 min before departure, or half-way for trips proposed less than an hour ahead. */
  lockAt: Date;
  chatClosesAt: Date;
  seats: number;
  fare: number;
  /** ceil(fare / seats / 50) × 50, computed here: what each passenger pays. The organizer covers empty seats. */
  seatPrice: number;
  /** Organizer + joined passengers + unpaid holds + seats forfeited after the lock. */
  seatsTaken: number;
  /** Next joinOrder: decides who the trip is handed over to. */
  joinSeq: number;
  status: TripStatus;
  /** Pinned by the organizer: "Peugeot 406 jaune · DK-1234-A". Shown to the trip's people only. */
  vehicle: string | null;
  departedAt: Date | null;
  cancelledAt: Date | null;
  claimPayoutId: ObjectId | null;
  /** Seats paid in the app (TAXI_ONLINE_PAYMENT when it was proposed). Missing: trips from before, all paid. */
  payOnline?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export const PARTICIPANT_STATUSES = ['pending_payment', 'joined', 'left', 'expired'] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

export type TaxiParticipantDoc = {
  _id: ObjectId;
  tripId: ObjectId;
  userId: ObjectId;
  role: 'organizer' | 'passenger';
  status: ParticipantStatus;
  joinOrder: number;
  paymentId: ObjectId | null;
  /** Unpaid seat released at this time. */
  holdExpiresAt: Date | null;
  /** When the seat was paid (or the trip created, for the organizer). */
  joinedAt: Date | null;
  checkedInAt: Date | null;
  leftAt: Date | null;
  /** Left after the lock: no refund, the seat money goes to the organizer. */
  forfeited: boolean;
  /** True while pending_payment or joined: one seat per student per trip (unique index). */
  active: boolean;
  /** True until the trip departs, is cancelled or is 15 min past its time: one trip at a time (unique index). */
  activeTrip: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type TaxiStrikeDoc = { _id: ObjectId; userId: ObjectId; tripId: ObjectId; reason: 'late_cancel'; at: Date };
