import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';

import type { Config } from '../../config/env.js';
import type { SessionDenylist } from '../../platform/auth/auth.js';
import type { Clock } from '../../platform/clock.js';
import type { Queues } from '../../platform/queue/queues.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { TokenService } from '../../platform/security/tokens.js';
import type { SmsSender } from '../../platform/sms/sms.js';
import type { AccountsApi } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import { AuthService } from './auth.service.js';
import { identityCollections } from './identity.collections.js';
import { otpProcessors } from './identity.jobs.js';
import { registerIdentityRoutes } from './identity.routes.js';
import { OtpService } from './otp.service.js';
import { SessionService } from './session.service.js';

export { identityCollections };
export { OTP_QUEUE } from './otp.service.js';

type Deps = {
  db: Db;
  mongo: MongoClient;
  config: Config;
  clock: Clock;
  queues: Queues;
  limiter: Limiter;
  tokens: TokenService;
  denylist: SessionDenylist;
  accounts: AccountsApi;
  audit: AuditApi;
};

export type IdentityApi = {
  registerRoutes(app: FastifyInstance): void;
  processors(sms: SmsSender): ReturnType<typeof otpProcessors>;
  /** Used by the seed and by tests: a logged-in session without going through OTP. */
  startSession(user: { _id: import('mongodb').ObjectId; platformRoles: string[] }): ReturnType<SessionService['start']>;
};

export function createIdentityModule(d: Deps): IdentityApi {
  const otp = new OtpService(d.db, d.config, d.clock, d.queues, d.limiter, d.tokens);
  const sessions = new SessionService(d.db, d.config, d.clock, d.tokens, d.denylist, d.audit);
  const auth = new AuthService(d.mongo, d.clock, d.accounts, otp, sessions, d.limiter, d.audit);
  return {
    registerRoutes: (app) => registerIdentityRoutes(app, { auth, otp, rateScale: d.config.RATE_LIMIT_SCALE }),
    processors: (sms) => otpProcessors(sms),
    startSession: (user) => sessions.start(user, { platform: 'internal' }, '127.0.0.1'),
  };
}
