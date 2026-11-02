import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import type { DataMigration } from '../../platform/db/migrations.js';
import { ORG_CAPABILITIES, ORG_CATEGORIES, ORG_LEVELS, ORG_ROLES } from './organizations.types.js';

export const organizationsCollections: CollectionSpec[] = [
  {
    name: 'organizations',
    validator: {
      $jsonSchema: bson.object(
        {
          slug: bson.string({ pattern: '^[a-z0-9-]{2,60}$' }),
          name: bson.string({ minLength: 2, maxLength: 80 }),
          category: bson.enumOf(ORG_CATEGORIES),
          capabilities: bson.array(bson.enumOf(ORG_CAPABILITIES)),
          level: bson.enumOf(ORG_LEVELS),
          status: bson.enumOf(['pending', 'active', 'suspended']),
          email: bson.nullable(bson.string({ maxLength: 254 })),
          logo: bson.nullable(bson.imageRef),
        },
        ['slug', 'name', 'category', 'capabilities', 'level', 'stats', 'status', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [{ key: { slug: 1 }, options: { name: 'slug_unique', unique: true } }],
  },
  {
    name: 'memberships',
    validator: {
      $jsonSchema: bson.object(
        {
          orgId: bson.objectId,
          userId: bson.objectId,
          roles: bson.array(bson.enumOf(ORG_ROLES), { minItems: 1 }),
          status: bson.enumOf(['active', 'revoked']),
        },
        ['orgId', 'userId', 'roles', 'status', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { orgId: 1, userId: 1 }, options: { name: 'org_user_unique', unique: true } },
      { key: { userId: 1, status: 1 }, options: { name: 'user_status' } },
    ],
  },
];

export const organizationsMigrations: DataMigration[] = [
  {
    id: '2026-10-31-organizations-kind-to-category',
    description: 'Rename organizations.kind to category; add email and logo (null).',
    async up(db) {
      const orgs = db.collection('organizations');
      await orgs.updateMany({ kind: { $exists: true } }, { $rename: { kind: 'category' } });
      await orgs.updateMany({ email: { $exists: false } }, { $set: { email: null } });
      await orgs.updateMany({ logo: { $exists: false } }, { $set: { logo: null } });
    },
  },
];
