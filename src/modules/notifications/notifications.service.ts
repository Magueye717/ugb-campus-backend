import { ObjectId, type ClientSession, type Collection, type Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { afterCommit } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import type { Queues } from '../../platform/queue/queues.js';
import type { RealtimeHub } from '../../platform/realtime/hub.js';
import type { AccountsApi } from '../accounts/index.js';
import type { PushSender } from './push.js';
import { SCOPE_TYPES, type NotificationScope } from './notifications.types.js';
import type { Broadcast, NewNotification, PushChannel, NotificationCategory, NotificationDoc, PushJob, PushTokenDoc } from './notifications.types.js';

export const PUSH_QUEUE = 'notifications.push';
const BROADCAST_BATCH = 500;
// Created by the app (lib/notifications.ts).
const ANDROID_CHANNELS: Record<PushChannel, string> = { campus: 'campus', orders: 'commandes' };

export const notificationView = (n: NotificationDoc) => ({
  id: n._id.toHexString(),
  category: n.category,
  type: n.type,
  title: n.title,
  body: n.body,
  icon: n.icon,
  tone: n.tone,
  url: n.url,
  read: !!n.readAt,
  createdAt: n.createdAt.toISOString(),
});

const inScope = (scope?: NotificationScope) => (scope ? { type: { $in: SCOPE_TYPES[scope] } } : {});

export class NotificationsService {
  private readonly notifications: Collection<NotificationDoc>;
  private readonly tokens: Collection<PushTokenDoc>;

  constructor(
    db: Db,
    private readonly clock: Clock,
    private readonly hub: RealtimeHub,
    private readonly queues: Queues,
    private readonly accounts: AccountsApi,
  ) {
    this.notifications = db.collection('notifications');
    this.tokens = db.collection('pushTokens');
  }

  /**
   * Tells these users that something happened: a line in their in-app list (unless `persist: false`), a live
   * update of the bell, and a push notification sent by the worker. Inside a transaction, nothing leaves before
   * the commit. The same `dedupeKey` never notifies a user twice (retried requests, webhooks sent twice).
   */
  async notify(userIds: ObjectId[], n: NewNotification, session?: ClientSession) {
    const users = [...new Map(userIds.map((u) => [u.toHexString(), u])).values()];
    if (!users.length) return;
    const now = this.clock.now();
    let fresh = users;
    if (n.persist !== false) {
      const res = await this.notifications.bulkWrite(
        users.map((userId) => ({
          updateOne: {
            filter: { userId, dedupeKey: n.dedupeKey },
            update: {
              $setOnInsert: {
                _id: new ObjectId(), userId, category: n.category, type: n.type, title: n.title.slice(0, 120), body: n.body.slice(0, 300),
                icon: n.icon, tone: n.tone ?? 'primary', url: n.url ?? null, dedupeKey: n.dedupeKey, readAt: null, createdAt: now,
              },
            },
            upsert: true,
          },
        })),
        { session, ordered: false },
      );
      // Only those who didn't have it yet are pushed (a retried event stays silent).
      const inserted = new Set(Object.keys(res.upsertedIds).map(Number));
      fresh = users.filter((_, i) => inserted.has(i));
    }
    if (!fresh.length) return;
    afterCommit(session, async () => {
      if (n.persist !== false) for (const u of fresh) await this.hub.publish(`user:${u.toHexString()}`, 'notification.created', { type: n.type });
      const job: PushJob = { userIds: fresh.map((u) => u.toHexString()), title: n.title, body: n.body, url: n.url ?? null, category: n.category, collapseId: n.persist === false ? n.dedupeKey : undefined, ...(n.channel ? { channel: n.channel } : {}) };
      await this.queues.add(PUSH_QUEUE, job, { jobId: `push-${n.dedupeKey.replace(/[^A-Za-z0-9_-]/g, '_')}-${now.getTime()}` });
    });
  }

  /**
   * Push to everyone with the app, no line in their list: short-lived campus news shown on the home screen anyway
   * (a dish sold out, a water cut). Queued once per `dedupeKey`; the worker sends it in batches.
   */
  async broadcast(b: Broadcast) {
    const targeted = !!b.segment && (b.segment.campuses.length > 0 || b.segment.ufrs.length > 0 || b.segment.regions.length > 0);
    const job: PushJob = { userIds: [], audience: 'all', ...(targeted ? { segment: b.segment } : {}), title: b.title, body: b.body, url: b.url, category: b.category, collapseId: b.dedupeKey };
    await this.queues.add(PUSH_QUEUE, job, { jobId: `broadcast-${b.dedupeKey.replace(/[^A-Za-z0-9_-]/g, '_')}` });
  }

  /** Worker: sends to every active phone of these users (or of everyone) whose switch for this category is on. */
  async sendPush(job: PushJob, sender: PushSender): Promise<{ sent: number }> {
    if (job.audience === 'all') {
      let sent = 0;
      // Users in batches: their phones, then the switches of those users. A segment: the students it targets.
      const users = job.segment ? await this.accounts.userIdsInAudience(job.segment) : await this.tokens.distinct('userId', { active: true });
      for (let i = 0; i < users.length; i += BROADCAST_BATCH) {
        const batch = users.slice(i, i + BROADCAST_BATCH).map((u) => u.toHexString());
        sent += (await this.sendPush({ ...job, audience: undefined, segment: undefined, userIds: batch }, sender)).sent;
      }
      return { sent };
    }
    const ids = job.userIds.map((u) => new ObjectId(u));
    const prefs = await this.accounts.notificationPrefsByIds(ids);
    const allowed = ids.filter((id) => prefs.get(id.toHexString())?.[job.category] !== false);
    const tokens = allowed.length ? await this.tokens.find({ userId: { $in: allowed }, active: true }).toArray() : [];
    if (!tokens.length) return { sent: 0 };
    const outcomes = await sender.send(
      tokens.map((t) => ({ to: t.token, title: job.title, body: job.body, data: { url: job.url }, channelId: ANDROID_CHANNELS[job.channel ?? 'campus'], sound: 'default' as const, ...(job.collapseId ? { collapseId: job.collapseId } : {}) })),
    );
    const now = this.clock.now();
    for (const [i, o] of outcomes.entries()) {
      if (o.ok) continue;
      // Uninstalled or token revoked: stop sending to it.
      const gone = o.error === 'DeviceNotRegistered';
      await this.tokens.updateOne({ _id: tokens[i]!._id }, { $set: { lastError: o.error, updatedAt: now, ...(gone ? { active: false } : {}) } });
    }
    return { sent: outcomes.filter((o) => o.ok).length };
  }

  /** The app sends its Expo push token after sign-in. A phone switching account moves to the new account. */
  async registerToken(userId: ObjectId, token: string, platform: PushTokenDoc['platform']) {
    const now = this.clock.now();
    await this.tokens.updateOne(
      { token },
      { $set: { userId, platform, active: true, lastError: null, updatedAt: now }, $setOnInsert: { _id: new ObjectId(), token, createdAt: now } },
      { upsert: true },
    );
  }

  /** Sign-out: this phone stops receiving this account's notifications. */
  async unregisterToken(userId: ObjectId, token: string) {
    await this.tokens.updateOne({ token, userId }, { $set: { active: false, updatedAt: this.clock.now() } });
  }

  async list(userId: ObjectId, opts: { category?: NotificationCategory; scope?: NotificationScope; before?: ObjectId; limit?: number }) {
    const limit = Math.min(opts.limit ?? 30, 100);
    const items = await this.notifications
      .find({ userId, ...inScope(opts.scope), ...(opts.category ? { category: opts.category } : {}), ...(opts.before ? { _id: { $lt: opts.before } } : {}) })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .toArray();
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }

  unreadCount(userId: ObjectId, scope?: NotificationScope) {
    return this.notifications.countDocuments({ userId, readAt: null, ...inScope(scope) });
  }

  /** `all` with a scope: everything read in that view only (the shop's orders), the rest stays unread. */
  async markRead(userId: ObjectId, input: { ids?: string[]; all?: boolean; scope?: NotificationScope }) {
    if (!input.all && !input.ids?.length) throw errors.validation('Indique les notifications lues.');
    const filter = input.all ? { userId, readAt: null, ...inScope(input.scope) } : { userId, readAt: null, _id: { $in: input.ids!.map((i) => new ObjectId(i)) } };
    await this.notifications.updateMany(filter, { $set: { readAt: this.clock.now() } });
  }
}
