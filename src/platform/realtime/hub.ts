import { Redis } from 'ioredis';

/** What travels on a topic: an event name and its data, the same for every subscriber. */
export type RealtimeEvent = { event: string; data: Record<string, unknown> };

type Listener = (e: RealtimeEvent) => void;

/** Decides whether a user may follow a topic, e.g. `conversation:<id>` → is this user a member. */
export type TopicAuthorizer = (userId: string, id: string) => Promise<boolean>;

/**
 * Cross-instance fan-out through Redis pub/sub (06-domain-designs §6). Modules publish after their data is
 * committed; each API instance subscribes in Redis only to the topics its own sockets follow (reference-counted)
 * and hands events to them. No state is shared between instances.
 */
export class RealtimeHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly authorizers = new Map<string, TopicAuthorizer>();
  private subscriber: Redis | null = null;

  constructor(
    private readonly publisher: Redis,
    private readonly redisUrl: string,
    private readonly prefix: string,
  ) {}

  private channel(topic: string) {
    return `${this.prefix}:rt:${topic}`;
  }

  /** The owning module of a topic kind says who may follow it ("conversation" → messaging). */
  authorize(kind: string, authorizer: TopicAuthorizer) {
    this.authorizers.set(kind, authorizer);
  }

  async canFollow(userId: string, topic: string): Promise<boolean> {
    const [kind, id] = topic.split(':', 2);
    if (kind === 'user') return id === userId;
    const authorizer = kind ? this.authorizers.get(kind) : undefined;
    return !!authorizer && !!id && authorizer(userId, id);
  }

  async publish(topic: string, event: string, data: Record<string, unknown>) {
    await this.publisher.publish(this.channel(topic), JSON.stringify({ event, data } satisfies RealtimeEvent));
  }

  /** Starts receiving a topic on this instance. Returns the matching unsubscribe. */
  async listen(topic: string, listener: Listener): Promise<() => Promise<void>> {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
      await this.sub().subscribe(this.channel(topic));
    }
    set.add(listener);
    return async () => {
      const current = this.listeners.get(topic);
      if (!current?.delete(listener) || current.size > 0) return;
      this.listeners.delete(topic);
      await this.sub().unsubscribe(this.channel(topic));
    };
  }

  /** One subscriber connection per instance, created on first use (a connection in subscribe mode can't run commands). */
  private sub(): Redis {
    if (this.subscriber) return this.subscriber;
    const sub = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    const head = `${this.prefix}:rt:`;
    sub.on('message', (channel: string, raw: string) => {
      if (!channel.startsWith(head)) return;
      const set = this.listeners.get(channel.slice(head.length));
      if (!set) return;
      let parsed: RealtimeEvent;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      for (const l of set) l(parsed);
    });
    this.subscriber = sub;
    return sub;
  }

  async close() {
    this.listeners.clear();
    if (this.subscriber) this.subscriber.disconnect();
    this.subscriber = null;
  }
}
