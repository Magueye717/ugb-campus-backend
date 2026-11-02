import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { PLACE_CATEGORIES } from './places.types.js';

export const placesCollections: CollectionSpec[] = [
  {
    name: 'places',
    validator: {
      $jsonSchema: bson.object(
        {
          name: bson.string({ minLength: 2, maxLength: 60 }),
          category: bson.enumOf(PLACE_CATEGORIES),
          description: bson.string({ maxLength: 600 }),
          area: bson.string({ maxLength: 80 }),
          location: bson.object({ lat: { bsonType: ['double', 'int'], minimum: -90, maximum: 90 }, lng: { bsonType: ['double', 'int'], minimum: -180, maximum: 180 } }, ['lat', 'lng']),
          icon: bson.string({ maxLength: 40 }),
          photos: bson.array(bson.object({ url: bson.string({ maxLength: 500 }) }, ['url', 'mediaId']), { maxItems: 6 }),
          active: bson.bool,
        },
        ['name', 'category', 'description', 'area', 'campus', 'location', 'hours', 'icon', 'photos', 'active', 'sortOrder', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [{ key: { active: 1, sortOrder: 1 }, options: { name: 'listing' } }],
  },
];
