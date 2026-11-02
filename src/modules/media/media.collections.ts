import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { MEDIA_PURPOSES } from './media.types.js';

export const mediaCollections: CollectionSpec[] = [
  {
    name: 'media',
    validator: {
      $jsonSchema: bson.object(
        {
          ownerId: bson.objectId,
          purpose: bson.enumOf(MEDIA_PURPOSES),
          key: bson.string({ maxLength: 200 }),
          url: bson.string({ maxLength: 500 }),
          contentType: bson.enumOf(['image/webp']),
          width: bson.int({ minimum: 1 }),
          height: bson.int({ minimum: 1 }),
          bytes: bson.int({ minimum: 1 }),
        },
        ['ownerId', 'purpose', 'key', 'url', 'contentType', 'width', 'height', 'bytes', 'createdAt'],
      ),
    },
    indexes: [
      { key: { key: 1 }, options: { name: 'key_unique', unique: true } },
      { key: { ownerId: 1, createdAt: -1 }, options: { name: 'owner_recent' } },
    ],
  },
];
