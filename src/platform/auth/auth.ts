import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Redis } from 'ioredis';

import { errors } from '../http/errors.js';
import type { TokenService } from '../security/tokens.js';

/** Who is calling. Capabilities (student, organizer roles, platform roles) are checked by the owning modules. */
export type Actor = { userId: string; sessionId: string; roles: string[] };

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

/** Revoked sessions, kept for the lifetime of an access token so revocation takes effect on the next request. */
export class SessionDenylist {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly ttlS: number,
  ) {}
  private key(sid: string) {
    return `${this.prefix}:sess:revoked:${sid}`;
  }
  async revoke(sessionIds: string[]) {
    if (!sessionIds.length) return;
    const m = this.redis.multi();
    for (const sid of sessionIds) m.set(this.key(sid), '1', 'EX', this.ttlS);
    await m.exec();
  }
  async isRevoked(sid: string) {
    return (await this.redis.exists(this.key(sid))) === 1;
  }
}

/** Reads the bearer token on every request. An invalid token is treated as no token; guards decide what's required. */
export const authPlugin = fp<{ tokens: TokenService; denylist: SessionDenylist }>(async (app, { tokens, denylist }) => {
  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const claims = await tokens.verifyAccess(header.slice(7).trim());
    if (!claims || (await denylist.isRevoked(claims.sid))) return;
    req.actor = { userId: claims.sub, sessionId: claims.sid, roles: claims.roles };
  });
});

export const requireAuth: preHandlerHookHandler = async (req: FastifyRequest, _reply: FastifyReply) => {
  if (!req.actor) throw errors.unauthenticated();
};

/** For handlers behind `requireAuth`. */
export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw errors.unauthenticated();
  return req.actor;
}
