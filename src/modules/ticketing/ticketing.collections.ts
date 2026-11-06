import type { DataMigration } from '../../platform/db/migrations.js';
import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { TICKET_KINDS, TICKET_PAYMENT_METHODS, TRANSFER_STATUSES } from './ticketing.types.js';

export const ticketingCollections: CollectionSpec[] = [
  {
    name: 'tickets',
    validator: {
      $jsonSchema: bson.object(
        {
          kind: bson.enumOf(TICKET_KINDS),
          eventId: bson.objectId,
          orgId: bson.objectId,
          code: bson.string({ pattern: '^[0-9A-HJKMNP-TV-Z]{6}$' }),
          purchaserUserId: bson.objectId,
          holderUserId: bson.objectId,
          passenger: bson.nullable(bson.object({ name: bson.string({ minLength: 2, maxLength: 60 }), phone: bson.string({ pattern: '^\\+221[0-9]{9}$' }) }, ['name', 'phone'])),
          holderTravels: bson.bool,
          source: bson.object({ type: bson.enumOf(['caravan_booking', 'event_booking']), id: bson.objectId }, ['type', 'id']),
          price: bson.int({ minimum: 0 }),
          paidWith: bson.enumOf(TICKET_PAYMENT_METHODS),
          cashCollectedAt: bson.nullable(bson.date),
          seat: bson.nullable(bson.int({ minimum: 1 })),
          details: { bsonType: 'object' },
          status: bson.enumOf(['active', 'cancelled']),
          version: bson.int({ minimum: 1 }),
        },
        ['kind', 'eventId', 'orgId', 'code', 'purchaserUserId', 'holderUserId', 'passenger', 'holderTravels', 'source', 'price', 'paidWith', 'seat', 'details', 'status', 'version', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      // Confirming a purchase twice (webhook retry) issues one ticket.
      { key: { 'source.type': 1, 'source.id': 1 }, options: { name: 'source_unique', unique: true } },
      { key: { eventId: 1, code: 1 }, options: { name: 'event_code_unique', unique: true } },
      // One valid ticket to travel on per person per event, whether bought or received. A purchaser also holds the
      // tickets of the companions they booked for (holderTravels false).
      { key: { eventId: 1, holderUserId: 1 }, options: { name: 'event_traveller_active_unique', unique: true, partialFilterExpression: { status: 'active', holderTravels: true } } },
      { key: { eventId: 1, purchaserUserId: 1 }, options: { name: 'event_purchaser' } },
      { key: { holderUserId: 1, createdAt: -1 }, options: { name: 'holder_recent' } },
      { key: { eventId: 1, status: 1 }, options: { name: 'event_status' } },
    ],
  },
  {
    name: 'ticketTransfers',
    validator: {
      $jsonSchema: bson.object(
        { ticketId: bson.objectId, eventId: bson.objectId, fromUserId: bson.objectId, toUserId: bson.objectId, status: bson.enumOf(TRANSFER_STATUSES), ticketVersion: bson.int({ minimum: 1 }), expiresAt: bson.date },
        ['ticketId', 'eventId', 'fromUserId', 'toUserId', 'status', 'ticketVersion', 'expiresAt', 'createdAt'],
      ),
    },
    indexes: [
      // One transfer in flight per ticket.
      { key: { ticketId: 1 }, options: { name: 'ticket_pending_unique', unique: true, partialFilterExpression: { status: 'pending' } } },
      { key: { toUserId: 1, status: 1 }, options: { name: 'recipient_status' } },
      { key: { fromUserId: 1, status: 1 }, options: { name: 'sender_status' } },
      { key: { status: 1, expiresAt: 1 }, options: { name: 'status_expires' } },
    ],
  },
  {
    name: 'admissions',
    validator: {
      $jsonSchema: bson.object(
        {
          orgId: bson.objectId,
          method: bson.enumOf(['qr', 'code', 'manual']),
          result: bson.enumOf(['admitted', 'duplicate', 'rejected']),
          scannedBy: bson.objectId,
          active: bson.bool,
        },
        ['orgId', 'method', 'result', 'scannedBy', 'scannedAt', 'receivedAt', 'active'],
      ),
    },
    indexes: [
      // Two phones scanning the same passenger at once: one boarding, the other is told "déjà à bord".
      { key: { ticketId: 1 }, options: { name: 'ticket_active_unique', unique: true, partialFilterExpression: { active: true } } },
      // A retried or offline-synced scan is recorded once.
      { key: { orgId: 1, clientScanId: 1 }, options: { name: 'client_scan_unique', unique: true, partialFilterExpression: { clientScanId: { $type: 'string' } } } },
      { key: { eventId: 1, receivedAt: -1 }, options: { name: 'event_recent' } },
    ],
  },
];

export const ticketingMigrations: DataMigration[] = [
  {
    id: '2026-11-01-tickets-passenger',
    description: 'Tickets get passenger (null) and holderTravels (true); the one-ticket-per-holder index only counts tickets the holder travels on.',
    async up(db) {
      await db.collection('tickets').updateMany({ holderTravels: { $exists: false } }, { $set: { passenger: null, holderTravels: true } });
      const indexes = await db.collection('tickets').indexes();
      if (indexes.some((ix) => ix.name === 'event_holder_active_unique')) await db.collection('tickets').dropIndex('event_holder_active_unique');
    },
  },
];
