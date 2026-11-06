import type { DataMigration } from '../../platform/db/migrations.js';
import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { CAMPUSES, REGIONS, UFR_CODES } from '../accounts/index.js';
import { ALERT_KINDS, ALERT_PLACEMENTS, ALERT_TONES } from './alerts.types.js';

export const alertsCollections: CollectionSpec[] = [
  {
    name: 'alerts',
    validator: {
      $jsonSchema: bson.object(
        {
          kind: bson.enumOf(ALERT_KINDS),
          placement: bson.enumOf(ALERT_PLACEMENTS),
          tag: bson.nullable(bson.string({ minLength: 2, maxLength: 24 })),
          title: bson.string({ minLength: 3, maxLength: 80 }),
          body: bson.string({ maxLength: 200 }),
          icon: bson.string({ maxLength: 40 }),
          tone: bson.enumOf(ALERT_TONES),
          href: bson.nullable(bson.string({ maxLength: 200 })),
          eventAt: bson.nullable(bson.date),
          audience: bson.object(
            { campuses: bson.array(bson.enumOf(CAMPUSES)), ufrs: bson.array(bson.enumOf(UFR_CODES)), regions: bson.array(bson.enumOf(REGIONS)) },
            ['campuses', 'ufrs', 'regions'],
          ),
          sourceKey: bson.nullable(bson.string({ maxLength: 120 })),
          startsAt: bson.date,
          endsAt: bson.date,
          push: bson.bool,
          pushedAt: bson.nullable(bson.date),
          withdrawnAt: bson.nullable(bson.date),
        },
        [
          'kind', 'placement', 'tag', 'title', 'body', 'icon', 'tone', 'href', 'eventAt', 'audience', 'sourceKey', 'startsAt', 'endsAt', 'push', 'pushedAt', 'withdrawnAt',
          'createdBy', 'updatedBy', 'createdAt', 'updatedAt',
        ],
      ),
    },
    indexes: [
      // The home screen: alerts not over yet.
      { key: { endsAt: 1 }, options: { name: 'ends' } },
      // A feature raising the same alert twice (sold out, back, sold out again) updates one alert.
      { key: { sourceKey: 1 }, options: { name: 'source_unique', unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } } },
      // The worker: pushes asked for alerts that just went online.
      { key: { push: 1, pushedAt: 1, startsAt: 1 }, options: { name: 'push_due' } },
    ],
  },
];

export const alertsMigrations: DataMigration[] = [
  {
    id: '2026-11-01-alerts-placement',
    description: 'Alerts get placement (banner), tag, eventAt, push, pushedAt and updatedBy ("À la une" is now an alert placement).',
    async up(db) {
      await db.collection('alerts').updateMany(
        { placement: { $exists: false } },
        { $set: { placement: 'banner', tag: null, eventAt: null, push: false, pushedAt: null, updatedBy: null } },
      );
    },
  },
  {
    id: '2026-11-05-alerts-images',
    description: 'An announcement keeps up to three photos (images) instead of one (image).',
    async up(db) {
      const alerts = db.collection('alerts');
      await alerts.updateMany({ image: { $type: 'object' } }, [{ $set: { images: ['$image'] } }, { $unset: 'image' }]);
      await alerts.updateMany({ image: { $exists: true } }, { $unset: { image: '' } });
    },
  },
  {
    id: '2026-11-01-alerts-audience',
    description: 'Alerts get an audience; existing ones are for the whole university.',
    async up(db) {
      await db.collection('alerts').updateMany({ audience: { $exists: false } }, { $set: { audience: { campuses: [], ufrs: [], regions: [] } } });
    },
  },
];
