import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { allCollections } from '../src/collections.js';
import { applyCollectionSpecs, bson } from '../src/platform/db/schema.js';
import { MONGO_TEST_URI } from './harness.js';

let client: MongoClient;
const commands: string[] = [];
beforeAll(async () => {
  client = new MongoClient(MONGO_TEST_URI, { monitorCommands: true });
  client.on('commandStarted', (e) => commands.push(e.commandName));
  await client.connect();
});
afterAll(async () => client.close());

describe('collection specs', () => {
  it('a deploy that changes no rule never rewrites validators (collMod needs dbAdmin)', async () => {
    const db = client.db(`ugb_test_schema_${randomUUID().slice(0, 8)}`);
    try {
      await applyCollectionSpecs(db, allCollections);
      commands.length = 0;
      await applyCollectionSpecs(db, allCollections);
      expect(commands).not.toContain('collMod');

      // A changed rule is applied, once.
      const users = allCollections.find((s) => s.name === 'users')!;
      const changed = { ...users, validator: { $jsonSchema: bson.object({ phone: bson.string() }, ['phone']) } };
      commands.length = 0;
      await applyCollectionSpecs(db, [changed]);
      expect(commands.filter((c) => c === 'collMod')).toHaveLength(1);
      commands.length = 0;
      await applyCollectionSpecs(db, [changed]);
      expect(commands).not.toContain('collMod');
    } finally {
      await db.dropDatabase();
    }
  });
});
