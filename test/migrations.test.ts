import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/collections.js';
import { createTestApp, type TestApp } from './harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('data migrations', () => {
  it('turns an organization written with "kind" into the current shape, once', async () => {
    const db = t.c.mongo.db;
    const _id = new ObjectId();
    const now = new Date();
    // A document as the previous version wrote it (bypasses today's validator).
    await db.collection('organizations').insertOne(
      { _id, slug: 'legacy', name: 'Legacy Transport', kind: 'Transporteur', capabilities: ['caravans'], level: 'nouveau', stats: { ratingAvg: null, ratingCount: 0, tripsCount: 0 }, status: 'active', payoutAccount: null, createdAt: now, updatedAt: now },
      { bypassDocumentValidation: true },
    );
    await db.collection('migrations').deleteOne({ _id: '2026-10-31-organizations-kind-to-category' as never });

    const applied = await migrateDatabase(db);
    expect(applied).toContain('2026-10-31-organizations-kind-to-category');
    const doc = await db.collection('organizations').findOne({ _id });
    expect(doc).toMatchObject({ category: 'Transporteur', email: null, logo: null });
    expect(doc).not.toHaveProperty('kind');

    // The migrated document passes the current validator on its next write.
    await expect(db.collection('organizations').updateOne({ _id }, { $set: { name: 'Legacy Transport SA' } })).resolves.toMatchObject({ modifiedCount: 1 });
    // Recorded: a second run does nothing.
    expect(await migrateDatabase(db)).toEqual([]);
  });
});
