import { ObjectId, type ClientSession, type Collection, type Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { afterCommit, isDuplicateKey } from '../../platform/db/mongo.js';
import { AppError, errors } from '../../platform/http/errors.js';
import type { RealtimeHub } from '../../platform/realtime/hub.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { NotificationsApi } from '../notifications/index.js';
import {
  MESSAGE_MAX_LENGTH,
  type ConversationDoc,
  type ConversationMember,
  type ConversationReadDoc,
  type ConversationType,
  type MessageDoc,
  type MessageReportDoc,
  type UserBlockDoc,
} from './messaging.types.js';

const PAGE = 50;

export const conversationTopic = (id: ObjectId | string) => `conversation:${typeof id === 'string' ? id : id.toHexString()}`;
const userTopic = (id: ObjectId) => `user:${id.toHexString()}`;

export type MessageView = {
  id: string;
  conversationId: string;
  kind: MessageDoc['kind'];
  body: string;
  author: { key: string; name: string; initials: string; role: string | null } | null;
  clientMessageId: string | null;
  createdAt: string;
};

export const messageView = (m: MessageDoc): MessageView => ({
  id: m._id.toHexString(),
  conversationId: m.conversationId.toHexString(),
  kind: m.kind,
  body: m.body,
  author: m.author ? { key: m.author.key, name: m.author.name, initials: m.author.initials, role: m.author.role } : null,
  clientMessageId: m.clientMessageId,
  createdAt: m.createdAt.toISOString(),
});

/** What the owning module says about a conversation; replaces the previous state. */
export type ConversationSync = {
  title: string;
  /** App route of the chat screen, for push notifications. */
  url: string | null;
  members: ConversationMember[];
  writableUntil: Date | null;
  status: ConversationDoc['status'];
};

export class MessagingService {
  private readonly conversations: Collection<ConversationDoc>;
  private readonly messages: Collection<MessageDoc>;
  private readonly reads: Collection<ConversationReadDoc>;
  private readonly blocks: Collection<UserBlockDoc>;
  private readonly reports: Collection<MessageReportDoc>;

  constructor(
    db: Db,
    private readonly clock: Clock,
    private readonly hub: RealtimeHub,
    private readonly limiter: Limiter,
    private readonly notifications: NotificationsApi,
  ) {
    this.conversations = db.collection('conversations');
    this.messages = db.collection('messages');
    this.reads = db.collection('conversationReads');
    this.blocks = db.collection('userBlocks');
    this.reports = db.collection('messageReports');
  }

  // ---- For owning modules (taxi, lost & found…) -------------------------------------------------------------------

  /**
   * Creates the conversation of a trip / claim if needed and sets who is in it. Called inside the owner's
   * transaction whenever membership changes; subscribers are told after commit, and those who lost access are
   * dropped by the gateway.
   */
  async sync(type: ConversationType, contextRef: ObjectId, state: ConversationSync, session?: ClientSession): Promise<ObjectId> {
    const now = this.clock.now();
    const conv = await this.conversations.findOneAndUpdate(
      { type, contextRef },
      {
        $set: { title: state.title, url: state.url, members: state.members, writableUntil: state.writableUntil, status: state.status, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), type, contextRef, lastMessageId: null, lastMessageAt: null, createdAt: now },
      },
      { upsert: true, returnDocument: 'after', session },
    );
    afterCommit(session, () => this.hub.publish(conversationTopic(conv!._id), 'conversation.updated', { conversationId: conv!._id.toHexString() }));
    return conv!._id;
  }

  /** A line from the app itself ("Fatou a rejoint le trajet"), shown to every member. */
  async postSystem(type: ConversationType, contextRef: ObjectId, body: string, session?: ClientSession) {
    const conv = await this.conversations.findOne({ type, contextRef }, { session });
    if (!conv) return null;
    return this.insert(conv, { author: null, kind: 'system', body: body.slice(0, MESSAGE_MAX_LENGTH), clientMessageId: null }, session);
  }

  async idsFor(type: ConversationType, contextRefs: ObjectId[]): Promise<Map<string, ObjectId>> {
    if (!contextRefs.length) return new Map();
    const rows = await this.conversations.find({ type, contextRef: { $in: contextRefs } }, { projection: { contextRef: 1 } }).toArray();
    return new Map(rows.map((r) => [r.contextRef.toHexString(), r._id]));
  }

  private async insert(conv: ConversationDoc, m: Pick<MessageDoc, 'author' | 'kind' | 'body' | 'clientMessageId'>, session?: ClientSession) {
    const now = this.clock.now();
    const doc: MessageDoc = { _id: new ObjectId(), conversationId: conv._id, ...m, createdAt: now };
    await this.messages.insertOne(doc, { session });
    await this.conversations.updateOne({ _id: conv._id }, { $set: { lastMessageId: doc._id, lastMessageAt: now } }, { session });
    afterCommit(session, async () => {
      await this.hub.publish(conversationTopic(conv._id), 'message.created', { message: messageView(doc) });
      // Badges: every other member's own channel, so lists update without following each conversation.
      for (const member of conv.members) {
        if (m.author?.userId.equals(member.userId)) continue;
        await this.hub.publish(userTopic(member.userId), 'conversation.activity', { conversationId: conv._id.toHexString() });
      }
    });
    return doc;
  }

  // ---- For the app ---------------------------------------------------------------------------------------------

  /** 404 for non-members: a conversation's existence is not revealed. */
  async forMember(conversationId: ObjectId, userId: ObjectId) {
    const conv = await this.conversations.findOne({ _id: conversationId, 'members.userId': userId });
    if (!conv) throw errors.notFound('Discussion introuvable.');
    return { conv, me: conv.members.find((m) => m.userId.equals(userId))! };
  }

  async isMember(conversationId: ObjectId, userId: ObjectId) {
    return (await this.conversations.countDocuments({ _id: conversationId, 'members.userId': userId }, { limit: 1 })) > 0;
  }

  canWrite(conv: ConversationDoc, me: ConversationMember) {
    return conv.status === 'open' && me.canWrite && (!conv.writableUntil || this.clock.now() < conv.writableUntil);
  }

  private async blockedIds(userId: ObjectId) {
    return (await this.blocks.find({ userId }, { projection: { blockedUserId: 1 } }).toArray()).map((b) => b.blockedUserId);
  }

  /** The members I blocked, by their key in this conversation: the app hides their live messages too. */
  async blockedKeys(conv: ConversationDoc, userId: ObjectId) {
    const blocked = await this.blockedIds(userId);
    return conv.members.filter((m) => blocked.some((b) => b.equals(m.userId))).map((m) => m.key);
  }

  /**
   * Oldest first. Without `after`: the latest page (or the page before `before`). With `after`: what the app
   * missed while offline. Messages of people I blocked are left out.
   */
  async list(conversationId: ObjectId, userId: ObjectId, opts: { before?: ObjectId; after?: ObjectId; limit?: number }) {
    await this.forMember(conversationId, userId);
    const limit = Math.min(opts.limit ?? PAGE, 100);
    const blocked = await this.blockedIds(userId);
    const filter = { conversationId, ...(blocked.length ? { 'author.userId': { $nin: blocked } } : {}) };
    if (opts.after) {
      const items = await this.messages.find({ ...filter, _id: { $gt: opts.after } }).sort({ _id: 1 }).limit(limit + 1).toArray();
      return { items: items.slice(0, limit), hasMore: items.length > limit };
    }
    const items = await this.messages
      .find({ ...filter, ...(opts.before ? { _id: { $lt: opts.before } } : {}) })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .toArray();
    return { items: items.slice(0, limit).reverse(), hasMore: items.length > limit };
  }

  /** A retry with the same clientMessageId returns the message already posted (`replay`). */
  async send(conversationId: ObjectId, userId: ObjectId, input: { body: string; kind: 'text' | 'quick_reply'; clientMessageId: string }) {
    const { conv, me } = await this.forMember(conversationId, userId);
    const existing = await this.messages.findOne({ conversationId, 'author.userId': userId, clientMessageId: input.clientMessageId });
    if (existing) return { message: existing, replay: true };
    if (!this.canWrite(conv, me)) throw new AppError(403, 'CHAT_READ_ONLY', 'Cette discussion est fermée : tu peux la lire, plus y écrire.');
    const body = input.body.trim();
    if (!body) throw errors.validation('Le message est vide.', { field: 'body' });
    await this.limiter.hit(`chat:${userId.toHexString()}:${conversationId.toHexString()}`, { limit: 20, windowS: 60 }, 'Tu envoies trop de messages. Patiente un peu.');
    try {
      const message = await this.insert(conv, {
        author: { userId, key: me.key, name: me.name, initials: me.initials, role: me.role },
        kind: input.kind,
        body,
        clientMessageId: input.clientMessageId,
      });
      await this.pushToOthers(conv, message);
      return { message, replay: false };
    } catch (err) {
      if (!isDuplicateKey(err, 'client_message_unique')) throw err;
      const message = await this.messages.findOne({ conversationId, 'author.userId': userId, clientMessageId: input.clientMessageId });
      return { message: message!, replay: true };
    }
  }

  /** A push to the other members (not to those who blocked the author). Not kept in the bell list: the chat is. */
  private async pushToOthers(conv: ConversationDoc, m: MessageDoc) {
    if (!m.author) return;
    const others = conv.members.filter((x) => !x.userId.equals(m.author!.userId)).map((x) => x.userId);
    const blocking = await this.blocks.find({ userId: { $in: others }, blockedUserId: m.author.userId }, { projection: { userId: 1 } }).toArray();
    const to = others.filter((u) => !blocking.some((b) => b.userId.equals(u)));
    await this.notifications.notify(to, {
      type: 'chat.message', category: 'social', icon: 'chatbubbles-outline', persist: false, url: conv.url,
      title: `${m.author.name} · ${conv.title}`, body: m.body.length > 140 ? `${m.body.slice(0, 139)}…` : m.body,
      dedupeKey: `chat:${conv._id.toHexString()}:${m._id.toHexString()}`,
    });
  }

  /** Only moves forward: an old screen marking an older message read doesn't bring unread messages back. */
  async markRead(conversationId: ObjectId, userId: ObjectId, lastReadMessageId: ObjectId) {
    await this.forMember(conversationId, userId);
    const exists = await this.messages.countDocuments({ _id: lastReadMessageId, conversationId }, { limit: 1 });
    if (!exists) throw errors.notFound('Message introuvable.');
    const now = this.clock.now();
    try {
      await this.reads.updateOne(
        { conversationId, userId, $or: [{ lastReadMessageId: { $lt: lastReadMessageId } }, { lastReadMessageId: { $exists: false } }] },
        { $set: { lastReadMessageId, updatedAt: now }, $setOnInsert: { _id: new ObjectId() } },
        { upsert: true },
      );
    } catch (err) {
      // Already further ahead: the upsert collided with the existing (newer) read marker.
      if (!isDuplicateKey(err)) throw err;
    }
  }

  /** Messages from others (not system lines, not blocked people) after my read marker. */
  async unreadCount(conv: ConversationDoc, userId: ObjectId, blocked?: ObjectId[]) {
    const read = await this.reads.findOne({ conversationId: conv._id, userId });
    const excluded = [userId, ...(blocked ?? (await this.blockedIds(userId)))];
    return this.messages.countDocuments({
      conversationId: conv._id,
      kind: { $ne: 'system' },
      'author.userId': { $nin: excluded },
      ...(read ? { _id: { $gt: read.lastReadMessageId } } : {}),
    });
  }

  /** My conversations, most recent activity first, with unread counts (badges). */
  async mine(userId: ObjectId, type?: ConversationType) {
    const convs = await this.conversations
      .find({ 'members.userId': userId, ...(type ? { type } : {}) })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .limit(50)
      .toArray();
    const blocked = await this.blockedIds(userId);
    const lastIds = convs.map((c) => c.lastMessageId).filter((id): id is ObjectId => !!id);
    const lasts = lastIds.length ? await this.messages.find({ _id: { $in: lastIds } }).toArray() : [];
    return Promise.all(
      convs.map(async (conv) => ({
        conv,
        me: conv.members.find((m) => m.userId.equals(userId))!,
        unread: await this.unreadCount(conv, userId, blocked),
        last: lasts.find((m) => conv.lastMessageId?.equals(m._id)) ?? null,
      })),
    );
  }

  // ---- Safety ----------------------------------------------------------------------------------------------------

  private async othersMessage(conversationId: ObjectId, userId: ObjectId, messageId: ObjectId) {
    const { conv } = await this.forMember(conversationId, userId);
    const message = await this.messages.findOne({ _id: messageId, conversationId });
    if (!message) throw errors.notFound('Message introuvable.');
    if (!message.author) throw errors.rule('SYSTEM_MESSAGE', 'Ce message vient de l’application.');
    if (message.author.userId.equals(userId)) throw errors.rule('OWN_MESSAGE', 'C’est ton propre message.');
    return { conv, message, authorId: message.author.userId };
  }

  /** Reviewed by the team (the reporter stays anonymous to the author). Reporting twice is a no-op. */
  async report(conversationId: ObjectId, userId: ObjectId, messageId: ObjectId, reason: string | null) {
    const { conv, message, authorId } = await this.othersMessage(conversationId, userId, messageId);
    try {
      await this.reports.insertOne({
        _id: new ObjectId(), messageId, conversationId, conversationType: conv.type, reporterId: userId, authorId,
        body: message.body, reason: reason?.trim().slice(0, 300) || null, status: 'open', createdAt: this.clock.now(),
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
  }

  /** Hides this person's messages from me in every conversation, now and later. */
  async blockAuthor(conversationId: ObjectId, userId: ObjectId, messageId: ObjectId) {
    const { authorId } = await this.othersMessage(conversationId, userId, messageId);
    await this.blocks.updateOne(
      { userId, blockedUserId: authorId },
      { $setOnInsert: { _id: new ObjectId(), createdAt: this.clock.now() } },
      { upsert: true },
    );
  }

  /** For moderation: the reports waiting for review. */
  openReports(limit = 100) {
    return this.reports.find({ status: 'open' }).sort({ createdAt: 1 }).limit(limit).toArray();
  }
}
