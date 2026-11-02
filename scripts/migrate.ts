import { allCollections, migrateDatabase } from '../src/collections.js';
import { loadConfig } from '../src/config/env.js';
import { connectMongo } from '../src/platform/db/mongo.js';

// Creates collections, validators and indexes, then runs pending data migrations. Idempotent: run on every deploy,
// before the new version starts.
const config = loadConfig();
const { client, db } = await connectMongo(config.MONGODB_URI, config.MONGODB_DB);
try {
  const applied = await migrateDatabase(db);
  console.log(`Applied ${allCollections.length} collection specs to "${config.MONGODB_DB}".`);
  console.log(applied.length ? `Data migrations run: ${applied.join(', ')}` : 'No pending data migration.');
} finally {
  await client.close();
}
