import type { Db } from 'mongodb';

/** A one-time data change (rename a field, backfill a value). Must be idempotent: it may meet half-migrated data. */
export type DataMigration = { id: string; description: string; up(db: Db): Promise<void> };

/** Runs, in order, the migrations not recorded yet in `migrations`, recording each one once it succeeds. */
export async function applyDataMigrations(db: Db, migrations: DataMigration[]): Promise<string[]> {
  const col = db.collection<{ _id: string; description: string; appliedAt: Date }>('migrations');
  const done = new Set((await col.find({}, { projection: { _id: 1 } }).toArray()).map((m) => m._id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await m.up(db);
    await col.insertOne({ _id: m.id, description: m.description, appliedAt: new Date() });
    applied.push(m.id);
  }
  return applied;
}
