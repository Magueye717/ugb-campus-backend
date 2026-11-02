import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { toObjectId } from '../../platform/http/schemas.js';
import { assertChannelAvailable, type AuthService } from './auth.service.js';
import type { OtpService } from './otp.service.js';
import {
  ChallengeParams, ChallengeResponse, ChangePasswordBody, CheckBody, CheckResponse, LoginBody, OtpBody, RefreshBody, RegisterBody,
  ResendBody, ResetBody, TokensSchema, VerifyBody, VerifyResponse,
} from './identity.schemas.js';

// Per-IP limits (Redis-backed, shared by every instance). Business keys (phone, identifier) are limited in the services.
const ctx = (req: FastifyRequest) => ({ ip: req.ip, requestId: req.id });

export function registerIdentityRoutes(root: FastifyInstance, { auth, otp, rateScale }: { auth: AuthService; otp: OtpService; rateScale: number }) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const perIp = (max: number, timeWindow: string) => ({ rateLimit: { max: max * rateScale, timeWindow } });
  const tags = ['auth'];

  app.post('/auth/register/check', { config: perIp(10, '1 hour'), schema: { tags, body: CheckBody, response: { 200: CheckResponse } } }, async (req) =>
    auth.checkAvailability(req.body),
  );

  app.post('/auth/otp', { config: perIp(20, '1 hour'), schema: { tags, body: OtpBody, response: { 202: ChallengeResponse } } }, async (req, reply) =>
    reply.status(202).send(await auth.requestOtp({ ...req.body, channel: req.body.channel ?? 'sms' }, ctx(req))),
  );

  app.post(
    '/auth/otp/:challengeId/resend',
    { config: perIp(20, '1 hour'), schema: { tags, params: ChallengeParams, body: ResendBody, response: { 202: ChallengeResponse } } },
    async (req, reply) => {
      const channel = req.body.channel ?? 'sms';
      assertChannelAvailable(channel);
      return reply.status(202).send(await otp.resend(toObjectId(req.params.challengeId), channel, req.ip));
    },
  );

  app.post(
    '/auth/otp/:challengeId/verify',
    { config: perIp(30, '10 minutes'), schema: { tags, params: ChallengeParams, body: VerifyBody, response: { 200: VerifyResponse } } },
    async (req) => otp.verify(toObjectId(req.params.challengeId), req.body.code),
  );

  app.post(
    '/auth/register',
    { config: perIp(10, '1 hour'), schema: { tags, body: RegisterBody, response: { 201: Type.Object({ userId: Type.String(), tokens: TokensSchema }) } } },
    async (req, reply) => {
      const { userId, tokens } = await auth.register(req.body, ctx(req));
      return reply.status(201).send({ userId: userId.toHexString(), tokens });
    },
  );

  app.post(
    '/auth/login',
    { config: perIp(30, '10 minutes'), schema: { tags, body: LoginBody, response: { 200: Type.Object({ userId: Type.String(), tokens: TokensSchema }) } } },
    async (req) => {
      const { userId, tokens } = await auth.login(req.body, ctx(req));
      return { userId: userId.toHexString(), tokens };
    },
  );

  app.post('/auth/refresh', { config: perIp(60, '10 minutes'), schema: { tags, body: RefreshBody, response: { 200: TokensSchema } } }, async (req) =>
    auth.refresh(req.body.refreshToken, ctx(req)),
  );

  app.post('/auth/logout', { preHandler: requireAuth, schema: { tags, body: RefreshBody } }, async (req, reply) => {
    await auth.logout(req.body.refreshToken, actorOf(req).userId);
    return reply.status(204).send();
  });

  app.post('/auth/logout-all', { preHandler: requireAuth, schema: { tags } }, async (req, reply) => {
    await auth.logoutAll(toObjectId(actorOf(req).userId), ctx(req));
    return reply.status(204).send();
  });

  app.post('/auth/password/reset', { config: perIp(10, '1 hour'), schema: { tags, body: ResetBody } }, async (req, reply) => {
    await auth.resetPassword(req.body, ctx(req));
    return reply.status(204).send();
  });

  app.put('/auth/password', { preHandler: requireAuth, config: perIp(10, '1 hour'), schema: { tags, body: ChangePasswordBody } }, async (req, reply) => {
    const actor = actorOf(req);
    await auth.changePassword(toObjectId(actor.userId), actor.sessionId, req.body, ctx(req));
    return reply.status(204).send();
  });
}
