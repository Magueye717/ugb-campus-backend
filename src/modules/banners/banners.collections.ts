import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { PAYMENT_METHODS } from '../payments/index.js';
import { BANNER_KINDS, BANNER_STATUSES, CTA_TARGETS } from './banners.types.js';

export const bannersCollections: CollectionSpec[] = [
  {
    name: 'bannerPackages',
    validator: {
      $jsonSchema: bson.object(
        { code: bson.string({ pattern: '^[a-z0-9-]{2,30}$' }), name: bson.string({ minLength: 2, maxLength: 40 }), days: bson.int({ minimum: 1, maximum: 60 }), price: bson.int({ minimum: 100, maximum: 1_000_000 }), active: bson.bool, sortOrder: bson.int() },
        ['code', 'name', 'days', 'price', 'active', 'sortOrder', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [{ key: { code: 1 }, options: { name: 'code_unique', unique: true } }],
  },
  {
    name: 'banners',
    validator: {
      $jsonSchema: bson.object(
        {
          kind: bson.enumOf(BANNER_KINDS),
          ownerId: bson.objectId,
          orgId: bson.nullable(bson.objectId),
          eventId: bson.nullable(bson.objectId),
          title: bson.string({ minLength: 3, maxLength: 40 }),
          description: bson.string({ maxLength: 90 }),
          image: bson.imageRef,
          cta: bson.nullable(bson.object({ label: bson.string({ minLength: 2, maxLength: 16 }), target: bson.enumOf(CTA_TARGETS), value: bson.string({ maxLength: 300 }) }, ['label', 'target', 'value'])),
          packageCode: bson.string(),
          days: bson.int({ minimum: 1 }),
          price: bson.int({ minimum: 0 }),
          method: bson.enumOf(PAYMENT_METHODS),
          startsAt: bson.date,
          endsAt: bson.date,
          status: bson.enumOf(BANNER_STATUSES),
        },
        ['kind', 'ownerId', 'orgId', 'eventId', 'title', 'description', 'image', 'cta', 'packageCode', 'days', 'price', 'method', 'startsAt', 'endsAt', 'status', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      // The carousel and the day-by-day capacity check.
      { key: { status: 1, startsAt: 1, endsAt: 1 }, options: { name: 'status_period' } },
      { key: { ownerId: 1, createdAt: -1 }, options: { name: 'owner_recent' } },
    ],
  },
];
