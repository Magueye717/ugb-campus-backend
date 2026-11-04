import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import type { DataMigration } from '../../platform/db/migrations.js';
import { ORG_CAPABILITIES, ORG_CATEGORIES, ORG_LEVELS, ORG_ROLES, ORG_SPACES, spacesOf } from './organizations.types.js';

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
          space: bson.enumOf(ORG_SPACES),
          roles: bson.array(bson.enumOf(ORG_ROLES), { minItems: 1 }),
          status: bson.enumOf(['active', 'revoked']),
        },
        ['orgId', 'userId', 'space', 'roles', 'status', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { orgId: 1, userId: 1, space: 1 }, options: { name: 'org_user_space_unique', unique: true } },
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
  {
    id: '2026-11-03-memberships-per-space',
    description: 'A membership per space of the organization (organizer, restaurant, shop): existing ones are copied into each space.',
    async up(db) {
      const members = db.collection('memberships');
      await members.dropIndex('org_user_unique').catch(() => undefined);
      const orgs = new Map((await db.collection('organizations').find({}, { projection: { capabilities: 1 } }).toArray()).map((o) => [o._id.toHexString(), o]));
      for (const m of await members.find({ space: { $exists: false } }).toArray()) {
        const o = orgs.get(m.orgId.toHexString());
        const [first, ...others] = spacesOf({ capabilities: o?.capabilities ?? [] });
        await members.updateOne({ _id: m._id }, { $set: { space: first } });
        for (const space of others) {
          const { _id: _ignored, ...rest } = m;
          await members.updateOne({ orgId: m.orgId, userId: m.userId, space }, { $setOnInsert: { ...rest, space } }, { upsert: true });
        }
      }
    },
  },
  {
    id: '2026-11-04-student-orgs-events-capability',
    description: 'Students’ own entities organize events: the capability becomes explicit (they may also open a shop).',
    async up(db) {
      await db.collection('organizations').updateMany({ category: 'Étudiant', capabilities: { $size: 0 } }, { $set: { capabilities: ['events'] } });
    },
  },
];
