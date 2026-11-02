import type { DataMigration } from '../../platform/db/migrations.js';
import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { PAYMENT_METHODS } from '../payments/index.js';
import { BOOKING_STATUSES, DEFAULT_MAX_SEATS_PER_STUDENT, DEPARTURE_STATUSES, DIRECTIONS, MAX_SEATS_PER_STUDENT } from './caravans.types.js';

const stop = bson.object({ stopId: bson.string({ minLength: 1, maxLength: 20 }), place: bson.string({ minLength: 2, maxLength: 80 }), at: bson.date }, ['stopId', 'place', 'at']);

export const caravansCollections: CollectionSpec[] = [
  {
    name: 'vehicles',
    validator: {
      $jsonSchema: bson.object(
        {
          orgId: bson.objectId,
          label: bson.string({ minLength: 2, maxLength: 60 }),
          plate: bson.string({ pattern: '^[A-Z0-9-]{4,15}$' }),
          capacity: bson.int({ minimum: 4, maximum: 90 }),
          seatsPerRow: bson.int({ minimum: 2, maximum: 6 }),
          blockedSeats: bson.array(bson.int({ minimum: 1 })),
          status: bson.enumOf(['active', 'retired']),
        },
        ['orgId', 'label', 'plate', 'capacity', 'seatsPerRow', 'blockedSeats', 'status', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { plate: 1 }, options: { name: 'plate_unique', unique: true } },
      { key: { orgId: 1, status: 1 }, options: { name: 'org_status' } },
    ],
  },
  {
    name: 'departures',
    validator: {
      $jsonSchema: bson.object(
        {
          code: bson.string({ pattern: '^[A-Z0-9]{5,10}$' }),
          orgId: bson.objectId,
          vehicleId: bson.objectId,
          direction: bson.enumOf(DIRECTIONS),
          from: bson.string({ minLength: 2, maxLength: 40 }),
          to: bson.string({ minLength: 2, maxLength: 40 }),
          pickups: bson.array(stop, { minItems: 1, maxItems: 15 }),
          dropoffs: bson.array(stop, { minItems: 1, maxItems: 15 }),
          departureAt: bson.date,
          price: bson.int({ minimum: 100, maximum: 100_000 }),
          maxSeatsPerStudent: bson.int({ minimum: 1, maximum: MAX_SEATS_PER_STUDENT }),
          minPassengers: bson.int({ minimum: 0 }),
          confirmBy: bson.date,
          bookingClosesAt: bson.date,
          status: bson.enumOf(DEPARTURE_STATUSES),
          seatsTaken: bson.int({ minimum: 0 }),
          seatsConfirmed: bson.int({ minimum: 0 }),
        },
        ['code', 'orgId', 'vehicleId', 'vehicle', 'direction', 'from', 'to', 'pickups', 'dropoffs', 'departureAt', 'price', 'maxSeatsPerStudent', 'minPassengers', 'confirmBy', 'bookingClosesAt', 'status', 'seatsTaken', 'seatsConfirmed', 'stopsLeft', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { code: 1 }, options: { name: 'code_unique', unique: true } },
      { key: { status: 1, direction: 1, departureAt: 1 }, options: { name: 'listing' } },
      { key: { orgId: 1, departureAt: -1 }, options: { name: 'org_recent' } },
      { key: { status: 1, confirmBy: 1 }, options: { name: 'confirm_deadline' } },
    ],
  },
  {
    name: 'bookings',
    validator: {
      $jsonSchema: bson.object(
        {
          departureId: bson.objectId,
          userId: bson.objectId,
          orderId: bson.objectId,
          slot: bson.int({ minimum: 1, maximum: MAX_SEATS_PER_STUDENT }),
          passenger: bson.nullable(bson.object({ name: bson.string({ minLength: 2, maxLength: 60 }), phone: bson.string({ pattern: '^\\+221[0-9]{9}$' }) }, ['name', 'phone'])),
          forSelf: bson.bool,
          seat: bson.int({ minimum: 1 }),
          pickupStopId: bson.string(),
          dropoffStopId: bson.string(),
          price: bson.int({ minimum: 0 }),
          method: bson.enumOf(PAYMENT_METHODS),
          status: bson.enumOf(BOOKING_STATUSES),
          seatActive: bson.bool,
          countsForLimit: bson.bool,
          holdExpiresAt: bson.date,
        },
        ['departureId', 'userId', 'orderId', 'slot', 'passenger', 'forSelf', 'seat', 'pickupStopId', 'dropoffStopId', 'price', 'method', 'status', 'seatActive', 'countsForLimit', 'holdExpiresAt', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      // Two students can never hold the same seat, whatever the timing.
      { key: { departureId: 1, seat: 1 }, options: { name: 'departure_seat_active_unique', unique: true, partialFilterExpression: { seatActive: true } } },
      // At most maxSeatsPerStudent purchases per student per departure (slots 1..max), still counted after giving a
      // ticket away. Two purchases at the same moment can't take the same slot.
      { key: { departureId: 1, userId: 1, slot: 1 }, options: { name: 'departure_user_slot_unique', unique: true, partialFilterExpression: { countsForLimit: true } } },
      // One seat for yourself being paid at a time (a confirmed one is a ticket: ticketing's index takes over).
      { key: { departureId: 1, userId: 1 }, options: { name: 'departure_user_self_held_unique', unique: true, partialFilterExpression: { status: 'held', forSelf: true } } },
      { key: { orderId: 1 }, options: { name: 'order' } },
      { key: { userId: 1, createdAt: -1 }, options: { name: 'user_recent' } },
      { key: { status: 1, holdExpiresAt: 1 }, options: { name: 'hold_expiry' } },
    ],
  },
];

export const caravansMigrations: DataMigration[] = [
  {
    id: '2026-11-01-caravans-seats-per-student',
    description: 'Departures get maxSeatsPerStudent (2); bookings get orderId (= _id), slot 1, passenger null, forSelf; the one-purchase index is replaced by slots.',
    async up(db) {
      await db.collection('departures').updateMany({ maxSeatsPerStudent: { $exists: false } }, { $set: { maxSeatsPerStudent: DEFAULT_MAX_SEATS_PER_STUDENT } });
      await db.collection('bookings').updateMany({ orderId: { $exists: false } }, [{ $set: { orderId: '$_id', slot: 1, passenger: null, forSelf: true } }]);
      const indexes = await db.collection('bookings').indexes();
      if (indexes.some((ix) => ix.name === 'departure_user_limit_unique')) await db.collection('bookings').dropIndex('departure_user_limit_unique');
    },
  },
];
