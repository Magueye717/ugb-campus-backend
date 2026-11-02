import type { FastifyInstance } from 'fastify';

import type { SessionDenylist } from '../auth/auth.js';
import type { Clock } from '../clock.js';
import type { TokenService } from '../security/tokens.js';
import type { RealtimeEvent, RealtimeHub } from './hub.js';

const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 25_000;
const MAX_TOPICS = 50;
const TOPIC_RE = /^[a-z_]+:[A-Za-z0-9_-]{1,64}$/;
/** Events after which the gateway checks again that each subscriber may still follow the topic. */
const ACCESS_EVENTS = new Set(['conversation.updated']);

/** Close codes the app reacts to: 4401 → refresh the token and reconnect. */
export const WS_UNAUTHORIZED = 4401;

/**
 * `/api/v1/ws`, server → client only (sending goes through REST: validated, rate-limited, idempotent).
 *
 * Client frames: `{type: 'auth', accessToken}` (first, within 5 s; again with a fresh token before it expires),
 * `{type: 'sub' | 'unsub', topic}`. Server frames: `ready`, `subscribed`, `unsubscribed`, `error`, and
 * `{type: 'event', topic, event, data}`. Each socket follows `user:<its user>` automatically.
 */
export function registerRealtimeGateway(app: FastifyInstance, deps: { hub: RealtimeHub; tokens: TokenService; denylist: SessionDenylist; clock: Clock }) {
  const { hub, tokens, denylist, clock } = deps;

  app.get('/ws', { websocket: true, schema: { hide: true } }, (socket) => {
    let userId: string | null = null;
    let alive = true;
    let expiry: NodeJS.Timeout | undefined;
    const subs = new Map<string, () => Promise<void>>();
    const send = (msg: Record<string, unknown>) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const close = (code: number, reason: string) => socket.close(code, reason);

    const authTimer = setTimeout(() => close(WS_UNAUTHORIZED, 'auth required'), AUTH_TIMEOUT_MS);
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    socket.on('pong', () => {
      alive = true;
    });

    const drop = async (topic: string) => {
      const off = subs.get(topic);
      subs.delete(topic);
      await off?.();
    };

    const follow = async (topic: string) => {
      if (subs.has(topic)) return;
      const off = await hub.listen(topic, (e: RealtimeEvent) => {
        send({ type: 'event', topic, event: e.event, data: e.data });
        // Membership changed (a passenger left…): stop sending to people who lost access.
        if (ACCESS_EVENTS.has(e.event) && userId) {
          void hub.canFollow(userId, topic).then(async (ok) => {
            if (ok) return;
            await drop(topic);
            send({ type: 'unsubscribed', topic, reason: 'revoked' });
          });
        }
      });
      subs.set(topic, off);
    };

    socket.on('message', async (raw: Buffer) => {
      let msg: { type?: unknown; accessToken?: unknown; topic?: unknown };
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return send({ type: 'error', code: 'BAD_REQUEST' });
      }

      if (msg.type === 'auth') {
        const claims = typeof msg.accessToken === 'string' ? await tokens.verifyAccess(msg.accessToken) : null;
        if (!claims || (await denylist.isRevoked(claims.sid)) || (userId && userId !== claims.sub)) {
          return close(WS_UNAUTHORIZED, 'unauthorized');
        }
        userId = claims.sub;
        clearTimeout(authTimer);
        clearTimeout(expiry);
        // The socket lives as long as the token: the app re-sends a fresh one, or reconnects on 4401.
        expiry = setTimeout(() => close(WS_UNAUTHORIZED, 'token expired'), Math.max(0, claims.exp * 1000 - clock.now().getTime()));
        await follow(`user:${userId}`);
        return send({ type: 'ready' });
      }
      if (!userId) return close(WS_UNAUTHORIZED, 'auth required');

      const topic = typeof msg.topic === 'string' ? msg.topic : '';
      if (msg.type === 'sub') {
        if (!TOPIC_RE.test(topic)) return send({ type: 'error', code: 'BAD_TOPIC', topic });
        if (subs.size >= MAX_TOPICS) return send({ type: 'error', code: 'TOO_MANY_TOPICS', topic });
        if (!(await hub.canFollow(userId, topic))) return send({ type: 'error', code: 'FORBIDDEN', topic });
        await follow(topic);
        return send({ type: 'subscribed', topic });
      }
      if (msg.type === 'unsub') {
        await drop(topic);
        return send({ type: 'unsubscribed', topic, reason: 'client' });
      }
      return send({ type: 'error', code: 'BAD_REQUEST' });
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      clearTimeout(expiry);
      clearInterval(heartbeat);
      for (const topic of [...subs.keys()]) void drop(topic);
    });
  });
}
