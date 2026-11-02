import { ObjectId, type ClientSession, type Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { bson, type CollectionSpec } from '../../platform/db/schema.js';

/** Append-only record of sensitive actions. Never contains secrets, codes or full phone numbers. */
export type AuditEntry = {
  actor: { type: 'user' | 'system' | 'provider'; id?: string };
  action: string;
  target: { type: string; id: string };
  requestId?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
};

export const auditCollections: CollectionSpec[] = [
  {
    name: 'auditLogs',
    validator: {
      $jsonSchema: bson.object(
        {
          actor: bson.object({ type: bson.enumOf(['user', 'system', 'provider']) }, ['type']),
          action: bson.string(),
          target: bson.object({ type: bson.string(), id: bson.string() }, ['type', 'id']),
          at: bson.date,
        },
        ['actor', 'action', 'target', 'at'],
      ),
    },
    indexes: [
      { key: { 'target.type': 1, 'target.id': 1, at: -1 }, options: { name: 'target_at' } },
      { key: { 'actor.id': 1, at: -1 }, options: { name: 'actor_at' } },
    ],
  },
];

export type AuditApi = { record(entry: AuditEntry, session?: ClientSession): Promise<void> };

export function createAuditModule(db: Db, clock: Clock): AuditApi {
  const col = db.collection('auditLogs');
  return {
    async record(entry, session) {
      await col.insertOne({ _id: new ObjectId(), ...entry, at: clock.now() }, { session });
    },
  };
}
