import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { CLAIM_ROLES, LOST_CATEGORIES, LOST_HOLDERS, LOST_KINDS, LOST_STATES, LOST_STATUSES, LOST_WHEN } from './lost.types.js';

export const lostCollections: CollectionSpec[] = [
  {
    name: 'lostItems',
    validator: {
      $jsonSchema: bson.object(
        {
          status: bson.enumOf(LOST_STATUSES),
          kind: bson.enumOf(LOST_KINDS),
          category: bson.enumOf(LOST_CATEGORIES),
          name: bson.string({ minLength: 2, maxLength: 40 }),
          details: bson.nullable(bson.string({ maxLength: 80 })),
          secret: bson.nullable(bson.string({ maxLength: 80 })),
          where: bson.string({ minLength: 1, maxLength: 40 }),
          spot: bson.nullable(bson.string({ maxLength: 60 })),
          when: bson.enumOf(LOST_WHEN),
          holder: bson.nullable(bson.enumOf(LOST_HOLDERS)),
          declaredBy: bson.objectId,
          state: bson.enumOf(LOST_STATES),
        },
        ['status', 'kind', 'category', 'name', 'details', 'secret', 'where', 'spot', 'when', 'holder', 'photo', 'declaredBy', 'declarer', 'owner', 'ownerNotifiedAt', 'state', 'returnedAt', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { state: 1, createdAt: -1 }, options: { name: 'board' } },
      { key: { declaredBy: 1, createdAt: -1 }, options: { name: 'declared_by' } },
      { key: { 'owner.userId': 1, createdAt: -1 }, options: { name: 'owner', sparse: true } },
    ],
  },
  {
    name: 'lostClaims',
    validator: {
      $jsonSchema: bson.object({ itemId: bson.objectId, declarerId: bson.objectId, otherId: bson.objectId, role: bson.enumOf(CLAIM_ROLES) }, ['itemId', 'declarerId', 'otherId', 'role', 'proof', 'createdAt']),
    },
    indexes: [
      // One conversation per item and person.
      { key: { itemId: 1, otherId: 1 }, options: { name: 'item_other_unique', unique: true } },
      { key: { otherId: 1 }, options: { name: 'other' } },
    ],
  },
];
