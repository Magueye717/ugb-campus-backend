import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import type { DataMigration } from '../../platform/db/migrations.js';
import { BUSINESS_KINDS, DELIVERY_ZONES, ITEM_SECTIONS, MAX_SPECIALTIES, ORDER_MODES, ORDER_PAYMENT_METHODS, ORDER_STATUSES } from './commerce.types.js';

const fee = bson.nullable(bson.int({ minimum: 0, maximum: 5000 }));

export const commerceCollections: CollectionSpec[] = [
  {
    name: 'businesses',
    validator: {
      $jsonSchema: bson.object(
        {
          orgId: bson.objectId,
          kind: bson.enumOf(BUSINESS_KINDS),
          name: bson.string({ minLength: 2, maxLength: 60 }),
          specialties: bson.array(bson.string({ maxLength: 40 }), { minItems: 1, maxItems: MAX_SPECIALTIES }),
          description: bson.string({ maxLength: 500 }),
          address: bson.string({ maxLength: 80 }),
          phone: bson.string({ maxLength: 20 }),
          deliveryFees: bson.object({ campus1: fee, campus2: fee, outside: fee }, [...DELIVERY_ZONES]),
          paymentMethods: bson.array(bson.enumOf(ORDER_PAYMENT_METHODS), { minItems: 1, maxItems: ORDER_PAYMENT_METHODS.length }),
          acceptingOrders: bson.bool,
          active: bson.bool,
        },
        ['orgId', 'kind', 'name', 'specialties', 'description', 'photo', 'location', 'address', 'campus', 'phone', 'services', 'deliveryFees', 'acceptingOrders', 'active', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { orgId: 1, kind: 1 }, options: { name: 'org_kind_unique', unique: true } },
      { key: { kind: 1, active: 1 }, options: { name: 'listing' } },
    ],
  },
  {
    name: 'catalogItems',
    validator: {
      $jsonSchema: bson.object(
        {
          businessId: bson.objectId,
          section: bson.enumOf(ITEM_SECTIONS),
          name: bson.string({ minLength: 2, maxLength: 50 }),
          detail: bson.string({ maxLength: 120 }),
          price: bson.int({ minimum: 0, maximum: 1_000_000 }),
          stock: bson.nullable(bson.int({ minimum: 0 })),
          available: bson.bool,
          orderable: bson.bool,
        },
        ['businessId', 'section', 'category', 'name', 'detail', 'price', 'photo', 'stock', 'available', 'orderable', 'sortOrder', 'archivedAt', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [{ key: { businessId: 1, archivedAt: 1, sortOrder: 1 }, options: { name: 'catalog' } }],
  },
  {
    name: 'commerceOrders',
    validator: {
      $jsonSchema: bson.object(
        {
          code: bson.string({ pattern: '^C[0-9A-Z]{6}$' }),
          businessId: bson.objectId,
          orgId: bson.objectId,
          userId: bson.objectId,
          lines: bson.array(bson.object({ itemId: bson.objectId, qty: bson.int({ minimum: 1, maximum: 20 }) }, ['itemId', 'name', 'price', 'qty']), { minItems: 1, maxItems: 30 }),
          total: bson.int({ minimum: 0 }),
          mode: bson.enumOf(ORDER_MODES),
          zone: bson.nullable(bson.enumOf(DELIVERY_ZONES)),
          method: bson.enumOf(ORDER_PAYMENT_METHODS),
          status: bson.enumOf(ORDER_STATUSES),
        },
        ['code', 'businessId', 'orgId', 'userId', 'lines', 'subtotal', 'deliveryFee', 'total', 'mode', 'address', 'note', 'method', 'paymentId', 'status', 'history', 'refusal', 'payoutId', 'refundPayoutId', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { code: 1 }, options: { name: 'code_unique', unique: true } },
      { key: { userId: 1, createdAt: -1 }, options: { name: 'mine' } },
      { key: { businessId: 1, status: 1, createdAt: -1 }, options: { name: 'business_queue' } },
      { key: { status: 1, updatedAt: 1 }, options: { name: 'sweep' } },
    ],
  },
];

export const commerceMigrations: DataMigration[] = [
  {
    id: '2026-11-04-business-per-kind-and-delivery-zones',
    description: 'One restaurant and one shop per organization (index on orgId + kind); one delivery price becomes a price per zone.',
    async up(db) {
      await db.collection('businesses').dropIndex('org_unique').catch(() => undefined);
      for (const b of await db.collection('businesses').find({ deliveryFees: { $exists: false } }).toArray()) {
        const f = (b.deliveryFee as number | null | undefined) ?? null;
        await db.collection('businesses').updateOne({ _id: b._id }, { $set: { deliveryFees: { campus1: f, campus2: f, outside: null } }, $unset: { deliveryFee: '' } });
      }
      await db.collection('commerceOrders').updateMany({ zone: { $exists: false } }, { $set: { zone: null } });
    },
  },
  {
    id: '2026-11-05-catalog-orderable',
    description: 'An item may be shown for information only (a service done on the spot); existing items stay orderable.',
    async up(db) {
      await db.collection('catalogItems').updateMany({ orderable: { $exists: false } }, { $set: { orderable: true } });
    },
  },
  {
    id: '2026-11-05-business-payment-methods',
    description: 'Each business chooses how students pay (cash, Wave, Orange Money); existing ones keep online payment only.',
    async up(db) {
      await db.collection('businesses').updateMany({ paymentMethods: { $exists: false } }, { $set: { paymentMethods: ['wave', 'orange_money'] } });
    },
  },
  {
    id: '2026-11-04-business-specialties',
    description: 'A business may have several specialties (Sénégalais and Grillades): `specialty` becomes the list `specialties`.',
    async up(db) {
      for (const b of await db.collection('businesses').find({ specialties: { $exists: false } }).toArray()) {
        const one = typeof b.specialty === 'string' && b.specialty.trim() ? [b.specialty.trim()] : ['Autre'];
        await db.collection('businesses').updateOne({ _id: b._id }, { $set: { specialties: one }, $unset: { specialty: '' } });
      }
    },
  },
];
