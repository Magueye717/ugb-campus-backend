import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { PARTICIPANT_STATUSES, TAXI_FARE, TAXI_SEATS, TRIP_STATUSES } from './taxi.types.js';

const place = bson.string({ minLength: 2, maxLength: 80 });

export const taxiCollections: CollectionSpec[] = [
  {
    name: 'taxiTrips',
    validator: {
      $jsonSchema: bson.object(
        {
          organizerUserId: bson.objectId,
          from: place,
          to: place,
          departureAt: bson.date,
          lockAt: bson.date,
          chatClosesAt: bson.date,
          seats: bson.int({ minimum: TAXI_SEATS.min, maximum: TAXI_SEATS.max }),
          fare: bson.int({ minimum: TAXI_FARE.min, maximum: TAXI_FARE.max }),
          seatPrice: bson.int({ minimum: 1 }),
          payOnline: bson.bool,
          // The seat counter can never go past the taxi's seats, whatever the code does.
          seatsTaken: bson.int({ minimum: 0, maximum: TAXI_SEATS.max }),
          joinSeq: bson.int({ minimum: 0 }),
          status: bson.enumOf(TRIP_STATUSES),
          vehicle: bson.nullable(bson.string({ maxLength: 60 })),
        },
        ['organizerUserId', 'from', 'to', 'departureAt', 'lockAt', 'chatClosesAt', 'seats', 'fare', 'seatPrice', 'seatsTaken', 'joinSeq', 'status', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { status: 1, departureAt: 1 }, options: { name: 'status_departure' } },
      { key: { organizerUserId: 1, status: 1 }, options: { name: 'organizer_status' } },
    ],
  },
  {
    name: 'taxiParticipants',
    validator: {
      $jsonSchema: bson.object(
        {
          tripId: bson.objectId,
          userId: bson.objectId,
          role: bson.enumOf(['organizer', 'passenger']),
          status: bson.enumOf(PARTICIPANT_STATUSES),
          joinOrder: bson.int({ minimum: 0 }),
          forfeited: bson.bool,
          active: bson.bool,
          activeTrip: bson.bool,
        },
        ['tripId', 'userId', 'role', 'status', 'joinOrder', 'forfeited', 'active', 'activeTrip', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      // One seat per student per trip, even with two taps at once.
      { key: { tripId: 1, userId: 1 }, options: { name: 'trip_user_active_unique', unique: true, partialFilterExpression: { active: true } } },
      // One trip at a time per student, organized or joined.
      { key: { userId: 1 }, options: { name: 'user_active_trip_unique', unique: true, partialFilterExpression: { activeTrip: true } } },
      { key: { tripId: 1, status: 1 }, options: { name: 'trip_status' } },
      { key: { userId: 1, createdAt: -1 }, options: { name: 'user_recent' } },
    ],
  },
  {
    name: 'taxiStrikes',
    validator: {
      $jsonSchema: bson.object({ userId: bson.objectId, tripId: bson.objectId, reason: bson.enumOf(['late_cancel']), at: bson.date }, ['userId', 'tripId', 'reason', 'at']),
    },
    indexes: [
      { key: { tripId: 1, userId: 1 }, options: { name: 'trip_user_unique', unique: true } },
      { key: { userId: 1, at: -1 }, options: { name: 'user_recent' } },
    ],
  },
];
