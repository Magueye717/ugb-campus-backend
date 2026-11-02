import { MongoClient, MongoServerError, type ClientSession, type Db } from 'mongodb';

export type Mongo = { client: MongoClient; db: Db };

export async function connectMongo(uri: string, dbName: string): Promise<Mongo> {
  const client = new MongoClient(uri, { maxPoolSize: 20, retryWrites: true, w: 'majority', serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  const db = client.db(dbName);
  await assertReplicaSet(db);
  return { client, db };
}

/** Bookings, cancellations and transfers rely on transactions: a standalone mongod can't run them. */
async function assertReplicaSet(db: Db) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName) {
    throw new Error(
      'MongoDB is not a replica set: transactions are unavailable. Start it with `--replSet rs0` and run `rs.initiate()` once, ' +
        'or use `docker compose up -d mongo` (see README).',
    );
  }
}

const pendingAfterCommit = new WeakMap<ClientSession, (() => unknown)[]>();

/**
 * Side effects that must only happen once the data is committed (publishing a real-time event, queueing a job).
 * Inside withTransaction they wait for the commit and are dropped if it aborts; without a session they run now.
 */
export function afterCommit(session: ClientSession | undefined, effect: () => unknown) {
  const list = session && pendingAfterCommit.get(session);
  if (list) list.push(effect);
  else void Promise.resolve().then(effect);
}

/** Runs `fn` in a majority transaction, retried by the driver on transient errors. */
export async function withTransaction<T>(client: MongoClient, fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = client.startSession();
  let effects: (() => unknown)[] = [];
  try {
    let result!: T;
    await session.withTransaction(
      async () => {
        // A retried attempt starts over: effects of the aborted one are forgotten.
        effects = [];
        pendingAfterCommit.set(session, effects);
        result = await fn(session);
      },
      { readConcern: { level: 'majority' }, writeConcern: { w: 'majority' }, readPreference: 'primary' },
    );
    pendingAfterCommit.delete(session);
    for (const effect of effects) {
      try {
        await effect();
      } catch {
        // Best effort (a missed real-time event is recovered by the client's next fetch).
      }
    }
    return result;
  } finally {
    pendingAfterCommit.delete(session);
    await session.endSession();
  }
}

/** E11000: a unique index rejected the write. `index` narrows it to a specific index name. */
export function isDuplicateKey(err: unknown, index?: string): boolean {
  if (!(err instanceof MongoServerError) || err.code !== 11000) return false;
  return index ? String(err.message).includes(index) : true;
}
