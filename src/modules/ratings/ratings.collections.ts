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
      { key: { userId: 1, subject: 1, subjectId: 1 }, options: { name: 'user_subject_unique', unique: true } },
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
