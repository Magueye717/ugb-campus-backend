import type { DataMigration } from '../../platform/db/migrations.js';
import type { CollectionSpec } from '../../platform/db/schema.js';
import { bson } from '../../platform/db/schema.js';
import { RATING_SUBJECTS } from './ratings.types.js';

export const ratingsCollections: CollectionSpec[] = [
  {
    name: 'ratings',
    validator: {
      $jsonSchema: bson.object(
        {
          userId: bson.objectId,
          subject: bson.enumOf(RATING_SUBJECTS),
          subjectId: bson.objectId,
          orgId: bson.objectId,
          businessId: bson.nullable(bson.objectId),
          stars: bson.nullable(bson.int({ minimum: 1, maximum: 5 })),
          comment: bson.string({ maxLength: 500 }),
          prompts: bson.int({ minimum: 0 }),
          declined: bson.bool,
        },
        ['userId', 'subject', 'subjectId', 'orgId', 'businessId', 'stars', 'comment', 'prompts', 'declined', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      // One per trip or event…
      { key: { userId: 1, subject: 1, subjectId: 1 }, options: { name: 'user_subject_unique', unique: true } },
      // …and one per restaurant or shop, whatever the number of orders: `user_business_unique`, created by the
      // migration below once the older duplicates are merged (an index here would fail on them first).
      // Averages: an organization's (trips and events), a business's (orders).
      { key: { orgId: 1, stars: 1 }, options: { name: 'org_stars' } },
      { key: { businessId: 1, stars: 1 }, options: { name: 'business_stars' } },
    ],
  },
  {
    // Services whose participants were asked (pushed) to rate: once each.
    name: 'ratingAsks',
    validator: { $jsonSchema: bson.object({ subject: bson.enumOf(RATING_SUBJECTS), subjectId: bson.objectId, at: bson.date }, ['subject', 'subjectId', 'at']) },
    indexes: [{ key: { subject: 1, subjectId: 1 }, options: { name: 'subject_unique', unique: true } }],
  },
];

export const ratingsMigrations: DataMigration[] = [
  {
    id: '2026-11-05-one-rating-per-business',
    description: 'One rating per student and restaurant/shop: of several, the one with stars (the latest) is kept.',
    async up(db) {
      const ratings = db.collection('ratings');
      const groups = await ratings.aggregate<{ _id: unknown; ids: { id: unknown; stars: number | null; at: Date }[] }>([
        { $match: { businessId: { $type: 'objectId' } } },
        { $group: { _id: { u: '$userId', b: '$businessId' }, ids: { $push: { id: '$_id', stars: '$stars', at: '$updatedAt' } }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ]).toArray();
      for (const g of groups) {
        const keep = [...g.ids].sort((a, b) => Number(b.stars !== null) - Number(a.stars !== null) || b.at.getTime() - a.at.getTime())[0]!;
        await ratings.deleteMany({ _id: { $in: g.ids.filter((x) => x.id !== keep.id).map((x) => x.id) } as never });
      }
      // The averages shown on the businesses follow.
      const avgs = await ratings.aggregate<{ _id: unknown; avg: number; n: number }>([{ $match: { businessId: { $type: 'objectId' }, stars: { $ne: null } } }, { $group: { _id: '$businessId', avg: { $avg: '$stars' }, n: { $sum: 1 } } }]).toArray();
      for (const a of avgs) await db.collection('businesses').updateOne({ _id: a._id as never }, { $set: { rating: { avg: Math.round(a.avg * 10) / 10, count: a.n } } });
      await ratings.createIndex({ userId: 1, businessId: 1 }, { name: 'user_business_unique', unique: true, partialFilterExpression: { businessId: { $type: 'objectId' } } });
    },
  },
];
