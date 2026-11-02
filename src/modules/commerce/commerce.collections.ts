import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { PAYMENT_METHODS } from '../payments/index.js';
import { BUSINESS_KINDS, ITEM_SECTIONS, ORDER_MODES, ORDER_STATUSES } from './commerce.types.js';

export const commerceCollections: CollectionSpec[] = [
  {
    name: 'businesses',
    validator: {
      $jsonSchema: bson.object(
        {
          orgId: bson.objectId,
          kind: bson.enumOf(BUSINESS_KINDS),
          name: bson.string({ minLength: 2, maxLength: 60 }),
          specialty: bson.string({ maxLength: 40 }),
          description: bson.string({ maxLength: 500 }),
          address: bson.string({ maxLength: 80 }),
          phone: bson.string({ maxLength: 20 }),
          deliveryFee: bson.nullable(bson.int({ minimum: 0, maximum: 5000 })),
          acceptingOrders: bson.bool,
          active: bson.bool,
        },
        ['orgId', 'kind', 'name', 'specialty', 'description', 'photo', 'location', 'address', 'campus', 'phone', 'services', 'deliveryFee', 'acceptingOrders', 'active', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { orgId: 1 }, options: { name: 'org_unique', unique: true } },
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
        },
        ['businessId', 'section', 'category', 'name', 'detail', 'price', 'photo', 'stock', 'available', 'sortOrder', 'archivedAt', 'createdAt', 'updatedAt'],
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
          method: bson.enumOf(PAYMENT_METHODS),
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
