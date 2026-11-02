import type { DataMigration } from '../../platform/db/migrations.js';
import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { CAMPUSES } from '../accounts/index.js';
import { DISH_STATUSES, MEALS } from './public-restos.types.js';

const hm = bson.string({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });
const service = bson.object({ start: hm, end: hm }, ['start', 'end']);
const dish = bson.object(
  {
    dishId: bson.string({ pattern: '^[0-9A-Za-z]{4,12}$' }),
    name: bson.string({ minLength: 2, maxLength: 60 }),
    detail: bson.string({ maxLength: 80 }),
    status: bson.enumOf(DISH_STATUSES),
    statusAt: bson.date,
  },
  ['dishId', 'name', 'detail', 'status', 'statusAt'],
);

export const publicRestosCollections: CollectionSpec[] = [
  {
    name: 'publicRestos',
    validator: {
      $jsonSchema: bson.object(
        {
          slug: bson.string({ pattern: '^[a-z0-9-]{2,40}$' }),
          name: bson.string({ minLength: 2, maxLength: 60 }),
          location: bson.string({ maxLength: 120 }),
          campus: bson.nullable(bson.enumOf(CAMPUSES)),
          sortOrder: bson.int(),
          services: bson.object({ lunch: service, dinner: service }, ['lunch', 'dinner']),
          status: bson.enumOf(['active', 'archived']),
        },
        ['slug', 'name', 'location', 'campus', 'sortOrder', 'services', 'status', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [{ key: { slug: 1 }, options: { name: 'slug_unique', unique: true } }],
  },
  {
    name: 'publicMenus',
    validator: {
      $jsonSchema: bson.object(
        {
          restoId: bson.objectId,
          date: bson.string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
          meal: bson.enumOf(MEALS),
          dishes: bson.array(dish, { maxItems: 12 }),
        },
        ['restoId', 'date', 'meal', 'dishes', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      // One menu per restaurant, day and meal: publishing again replaces it.
      { key: { restoId: 1, date: 1, meal: 1 }, options: { name: 'resto_date_meal_unique', unique: true } },
      // The home screen: every restaurant's menus of the day.
      { key: { date: 1 }, options: { name: 'date' } },
    ],
  },
];

export const publicRestosMigrations: DataMigration[] = [
  {
    id: '2026-11-01-dishes-no-critical',
    description: 'The "Presque fini" stock level is dropped: critical dishes become low ("Bientôt fini").',
    async up(db) {
      await db.collection('publicMenus').updateMany({ 'dishes.status': 'critical' }, { $set: { 'dishes.$[d].status': 'low' } }, { arrayFilters: [{ 'd.status': 'critical' }] });
    },
  },
  {
    id: '2026-11-01-public-restos-campus',
    description: 'Restaurants get a campus (null: for everyone) so their ruptures reach that campus only.',
    async up(db) {
      await db.collection('publicRestos').updateMany({ campus: { $exists: false } }, { $set: { campus: null } });
    },
  },
];
