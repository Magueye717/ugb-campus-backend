import { ObjectId } from 'mongodb';

import type { DataMigration } from '../../platform/db/migrations.js';
import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { CAMPUSES } from '../accounts/index.js';
import { CAMPUS_RESTOS } from './public-restos.catalog.js';
import { DEFAULT_SERVICES, DISH_STATUSES, MEALS, type Meal } from './public-restos.types.js';

/** "Thiébou  Dieun " → "thiébou dieun": one catalogue entry per dish name. */
export const dishKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** The dishes the university restaurants usually serve: the staff pick them instead of typing them. */
const COMMON_DISHES: { name: string; detail: string; meals: Meal[] }[] = [
  { name: 'Thiébou dieun', detail: 'Riz au poisson', meals: ['lunch'] },
  { name: 'Thiébou yapp', detail: 'Riz à la viande', meals: ['lunch'] },
  { name: 'Yassa poulet', detail: 'Riz · poulet aux oignons', meals: ['lunch'] },
  { name: 'Mafé', detail: 'Riz · sauce arachide', meals: ['lunch'] },
  { name: 'Domoda', detail: 'Riz · sauce tomate', meals: ['lunch'] },
  { name: 'Soupou kandja', detail: 'Riz · sauce gombo', meals: ['lunch'] },
  { name: 'Vermicelle', detail: 'Poulet · légumes', meals: ['lunch', 'dinner'] },
  { name: 'Bassi salté', detail: 'Couscous de mil · viande', meals: ['lunch', 'dinner'] },
  { name: 'Niébé', detail: 'Haricots · pain', meals: ['dinner'] },
  { name: 'Ndambé', detail: 'Haricots en sauce · pain', meals: ['dinner'] },
  { name: 'Couscous', detail: 'Sauce à la viande', meals: ['dinner'] },
  { name: 'Spaghetti bolognaise', detail: 'Viande hachée · sauce tomate', meals: ['dinner'] },
  { name: 'Petits pois', detail: 'Viande · pain', meals: ['dinner'] },
  { name: 'Lakh', detail: 'Bouillie de mil · lait caillé', meals: ['dinner'] },
  { name: 'Frites omelette', detail: 'Pain', meals: ['dinner'] },
];

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
  {
    id: '2026-11-05-public-dishes',
    description: 'The dish catalogue of the public restaurants: the usual dishes, and every dish already published.',
    async up(db) {
      const now = new Date();
      const dishes = db.collection('publicDishes');
      const add = (name: string, detail: string, meals: Meal[], uses: number) =>
        dishes.updateOne(
          { key: dishKey(name) },
          { $setOnInsert: { _id: new ObjectId(), name: name.trim(), detail, createdAt: now }, $addToSet: { meals: { $each: meals } }, $inc: { uses }, $set: { updatedAt: now } },
          { upsert: true },
        );
      for (const d of COMMON_DISHES) await add(d.name, d.detail, d.meals, 0);
      for (const m of await db.collection('publicMenus').find({}).toArray()) for (const d of m.dishes as { name: string; detail: string }[]) await add(d.name, d.detail, [m.meal as Meal], 1);
    },
  },
  {
    id: '2026-11-05-campus-restos',
    description: 'Resto 1 and Resto 2, added once (by slug), without menus',
    async up(db) {
      const restos = db.collection('publicRestos');
      const now = new Date();
      for (const [i, r] of CAMPUS_RESTOS.entries()) {
        // Never twice, never over one the team already created or archived.
        await restos.updateOne(
          { slug: r.slug },
          {
            $setOnInsert: {
              _id: new ObjectId(), slug: r.slug, name: r.name, location: r.location, campus: r.campus, point: r.coords, sortOrder: i + 1,
              services: DEFAULT_SERVICES, status: 'active', createdAt: now, updatedAt: now,
            },
          },
          { upsert: true },
        );
      }
    },
  },
];
