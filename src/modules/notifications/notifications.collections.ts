import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_TONES } from './notifications.types.js';

export const notificationsCollections: CollectionSpec[] = [
  {
    name: 'notifications',
    validator: {
      $jsonSchema: bson.object(
        {
          userId: bson.objectId,
          category: bson.enumOf(NOTIFICATION_CATEGORIES),
          type: bson.string({ maxLength: 60 }),
          title: bson.string({ minLength: 1, maxLength: 120 }),
          body: bson.string({ maxLength: 300 }),
          icon: bson.string({ maxLength: 40 }),
          tone: bson.enumOf(NOTIFICATION_TONES),
          dedupeKey: bson.string({ maxLength: 120 }),
        },
        ['userId', 'category', 'type', 'title', 'body', 'icon', 'tone', 'dedupeKey', 'createdAt'],
      ),
    },
    indexes: [
      { key: { userId: 1, dedupeKey: 1 }, options: { name: 'user_dedupe_unique', unique: true } },
      { key: { userId: 1, createdAt: -1 }, options: { name: 'user_recent' } },
      { key: { userId: 1, readAt: 1 }, options: { name: 'user_unread', partialFilterExpression: { readAt: null } } },
      // The list keeps 90 days.
      { key: { createdAt: 1 }, options: { name: 'ttl_90d', expireAfterSeconds: 90 * 24 * 3600 } },
    ],
  },
  {
    name: 'pushTokens',
    validator: {
      $jsonSchema: bson.object(
        { token: bson.string({ pattern: '^Expo(nent)?PushToken\\[.+\\]$' }), userId: bson.objectId, platform: bson.enumOf(['ios', 'android', 'web']), active: bson.bool },
        ['token', 'userId', 'platform', 'active', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { token: 1 }, options: { name: 'token_unique', unique: true } },
      { key: { userId: 1, active: 1 }, options: { name: 'user_active' } },
    ],
  },
];
