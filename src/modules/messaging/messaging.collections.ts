import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { CONVERSATION_TYPES, MESSAGE_KINDS, MESSAGE_MAX_LENGTH } from './messaging.types.js';

const identity = { key: bson.string({ minLength: 1, maxLength: 64 }), name: bson.string({ maxLength: 80 }), initials: bson.string({ maxLength: 4 }) };

export const messagingCollections: CollectionSpec[] = [
  {
    name: 'conversations',
    validator: {
      $jsonSchema: bson.object(
        {
          type: bson.enumOf(CONVERSATION_TYPES),
          contextRef: bson.objectId,
          title: bson.string({ maxLength: 200 }),
          members: bson.array(bson.object({ userId: bson.objectId, ...identity, canWrite: bson.bool }, ['userId', 'key', 'name', 'initials', 'canWrite']), { maxItems: 20 }),
          status: bson.enumOf(['open', 'closed']),
        },
        ['type', 'contextRef', 'title', 'members', 'status', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { type: 1, contextRef: 1 }, options: { name: 'type_context_unique', unique: true } },
      // "My conversations", newest activity first.
      { key: { 'members.userId': 1, lastMessageAt: -1 }, options: { name: 'member_recent' } },
    ],
  },
  {
    name: 'messages',
    validator: {
      $jsonSchema: bson.object(
        {
          conversationId: bson.objectId,
          kind: bson.enumOf(MESSAGE_KINDS),
          body: bson.string({ minLength: 1, maxLength: MESSAGE_MAX_LENGTH }),
          author: bson.nullable(bson.object({ userId: bson.objectId, ...identity }, ['userId', 'key', 'name', 'initials'])),
        },
        ['conversationId', 'kind', 'body', 'author', 'createdAt'],
      ),
    },
    indexes: [
      { key: { conversationId: 1, _id: -1 }, options: { name: 'conversation_page' } },
      // A retried send (same clientMessageId) can never post twice.
      {
        key: { conversationId: 1, 'author.userId': 1, clientMessageId: 1 },
        options: { name: 'client_message_unique', unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } },
      },
    ],
  },
  {
    name: 'conversationReads',
    indexes: [{ key: { conversationId: 1, userId: 1 }, options: { name: 'conversation_user_unique', unique: true } }],
  },
  {
    name: 'userBlocks',
    indexes: [{ key: { userId: 1, blockedUserId: 1 }, options: { name: 'user_blocked_unique', unique: true } }],
  },
  {
    name: 'messageReports',
    indexes: [
      { key: { messageId: 1, reporterId: 1 }, options: { name: 'message_reporter_unique', unique: true } },
      { key: { status: 1, createdAt: 1 }, options: { name: 'status_created' } },
    ],
  },
];
