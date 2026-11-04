import { bson, type CollectionSpec } from '../../platform/db/schema.js';

export const identityCollections: CollectionSpec[] = [
  {
    name: 'otpChallenges',
    validator: {
      $jsonSchema: bson.object(
        {
          purpose: bson.enumOf(['register', 'reset_password', 'change_phone']),
          phone: bson.string(),
          codeHash: bson.string({ minLength: 64, maxLength: 64 }),
          attempts: bson.int({ minimum: 0 }),
          maxAttempts: bson.int({ minimum: 1 }),
          status: bson.enumOf(['pending', 'verified', 'consumed', 'locked']),
          expiresAt: bson.date,
          purgeAt: bson.date,
        },
        ['purpose', 'phone', 'codeHash', 'attempts', 'maxAttempts', 'status', 'expiresAt', 'purgeAt', 'createdAt'],
      ),
    },
    indexes: [
      { key: { phone: 1, purpose: 1, createdAt: -1 }, options: { name: 'phone_purpose' } },
      { key: { purgeAt: 1 }, options: { name: 'purge_ttl', expireAfterSeconds: 0 } },
    ],
  },
  {
    name: 'sessions',
    validator: {
      $jsonSchema: bson.object(
        {
          userId: bson.objectId,
          familyId: bson.objectId,
          tokenHash: bson.string({ minLength: 64, maxLength: 64 }),
          status: bson.enumOf(['active', 'rotated', 'revoked']),
          expiresAt: bson.date,
        },
        ['userId', 'familyId', 'familyStartedAt', 'tokenHash', 'status', 'createdAt', 'expiresAt'],
      ),
    },
    indexes: [
      { key: { tokenHash: 1 }, options: { name: 'token_hash_unique', unique: true } },
      { key: { userId: 1, status: 1 }, options: { name: 'user_status' } },
      { key: { familyId: 1 }, options: { name: 'family' } },
      { key: { expiresAt: 1 }, options: { name: 'expires_ttl', expireAfterSeconds: 0 } },
    ],
  },
];
