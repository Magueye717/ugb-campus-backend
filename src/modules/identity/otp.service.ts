import { ObjectId, type ClientSession, type Collection, type Db } from 'mongodb';

import type { Config } from '../../config/env.js';
import type { Clock } from '../../platform/clock.js';
import { AppError, errors } from '../../platform/http/errors.js';
import type { Queues } from '../../platform/queue/queues.js';
import { hmac, randomDigits, safeEqual } from '../../platform/security/crypto.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { TokenService } from '../../platform/security/tokens.js';
import type { OtpChallengeDoc, OtpChannel, OtpPurpose } from './identity.types.js';

// Same numbers as the app (features/register/auth.ts).
export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_DELAY_S = 60;
const MAX_SENDS = 3;
const PURGE_AFTER_MS = 24 * 3600_000;

export const OTP_QUEUE = 'otp.send';
export type OtpJob = { challengeId: string; phone: string; code: string; channel: OtpChannel; purpose: OtpPurpose };

export class OtpService {
  private readonly col: Collection<OtpChallengeDoc>;

  constructor(
    db: Db,
    private readonly config: Pick<Config, 'OTP_PEPPER' | 'OTP_LENGTH' | 'OTP_DEV_MODE'>,
    private readonly clock: Clock,
    private readonly queues: Queues,
    private readonly limiter: Limiter,
    private readonly tokens: TokenService,
  ) {
    this.col = db.collection<OtpChallengeDoc>('otpChallenges');
  }

  private newCode() {
    // Development: 1234 (sent back as `devCode`, the app shows it). Refused in production by loadConfig.
    return this.config.OTP_DEV_MODE ? '12345678'.slice(0, this.config.OTP_LENGTH) : randomDigits(this.config.OTP_LENGTH);
  }

  private hash(challengeId: ObjectId, code: string) {
    // Bound to the challenge: the same code on another challenge hashes differently.
    return hmac(this.config.OTP_PEPPER, `${challengeId.toHexString()}:${code}`);
  }

  /** Per phone and per IP, on top of the route limit: stops SMS pumping and code farming. */
  private async throttle(phone: string, ip: string) {
    await this.limiter.hit(`otp:phone:${phone}`, { limit: 5, windowS: 24 * 3600 }, 'Trop de codes demandés pour ce numéro aujourd’hui.');
    await this.limiter.hit(`otp:ip:${ip}`, { limit: 20, windowS: 3600 });
  }

  async create(input: { phone: string; purpose: OtpPurpose; channel: OtpChannel; ip: string }) {
    await this.throttle(input.phone, input.ip);
    const now = this.clock.now();
    const _id = new ObjectId();
    const code = this.newCode();
    const doc: OtpChallengeDoc = {
      _id,
      purpose: input.purpose,
      phone: input.phone,
      codeHash: this.hash(_id, code),
      attempts: 0,
      maxAttempts: OTP_MAX_ATTEMPTS,
      sendCount: 1,
      lastSentAt: now,
      channel: input.channel,
      status: 'pending',
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      purgeAt: new Date(now.getTime() + OTP_TTL_MS + PURGE_AFTER_MS),
      ip: input.ip,
      createdAt: now,
    };
    await this.col.insertOne(doc);
    await this.deliver(doc, code);
    return this.publicView(doc);
  }

  /** A new code on the same challenge (the previous one stops working), after the resend delay. */
  async resend(challengeId: ObjectId, channel: OtpChannel, ip: string) {
    const now = this.clock.now();
    const current = await this.col.findOne({ _id: challengeId });
    if (!current || current.status !== 'pending' || current.expiresAt <= now) throw errors.gone('OTP_EXPIRED', 'Ce code a expiré. Recommence.');
    const wait = OTP_RESEND_DELAY_S - Math.floor((now.getTime() - current.lastSentAt.getTime()) / 1000);
    if (wait > 0) throw errors.tooMany(`Attends ${wait} s avant de demander un nouveau code.`, wait);
    if (current.sendCount >= MAX_SENDS) throw errors.tooMany('Trop de codes envoyés. Recommence plus tard.');
    await this.throttle(current.phone, ip);

    const code = this.newCode();
    const updated = await this.col.findOneAndUpdate(
      { _id: challengeId, status: 'pending', sendCount: current.sendCount },
      {
        $set: {
          codeHash: this.hash(challengeId, code),
          lastSentAt: now, channel, attempts: 0,
          expiresAt: new Date(now.getTime() + OTP_TTL_MS),
          purgeAt: new Date(now.getTime() + OTP_TTL_MS + PURGE_AFTER_MS),
        },
        $inc: { sendCount: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!updated) throw errors.tooMany('Un code vient déjà d’être envoyé.');
    await this.deliver(updated, code);
    return this.publicView(updated);
  }

  /**
   * Every attempt is counted atomically before the code is compared, so parallel guesses can't exceed the limit.
   * Answers mirror the app's VerifyResult: invalid (attemptsLeft) / expired / locked.
   */
  async verify(challengeId: ObjectId, code: string): Promise<{ verificationToken: string }> {
    const now = this.clock.now();
    const current = await this.col.findOne({ _id: challengeId });
    if (!current || current.status === 'verified' || current.status === 'consumed' || current.expiresAt <= now) {
      throw errors.gone('OTP_EXPIRED', 'Ce code a expiré. Demande un nouveau code.');
    }
    if (current.status === 'locked') throw errors.locked('OTP_LOCKED', 'Trop de tentatives. Demande un nouveau code.');

    const counted = await this.col.findOneAndUpdate(
      { _id: challengeId, status: 'pending', attempts: { $lt: current.maxAttempts } },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    if (!counted) {
      await this.col.updateOne({ _id: challengeId, status: 'pending' }, { $set: { status: 'locked' } });
      throw errors.locked('OTP_LOCKED', 'Trop de tentatives. Demande un nouveau code.');
    }

    if (/^\d+$/.test(code) && safeEqual(this.hash(challengeId, code), counted.codeHash)) {
      const done = await this.col.updateOne({ _id: challengeId, status: 'pending' }, { $set: { status: 'verified' } });
      if (done.modifiedCount === 1) {
        const verificationToken = await this.tokens.signVerification({ phone: counted.phone, purpose: counted.purpose, challengeId: challengeId.toHexString() });
        return { verificationToken };
      }
    }
    const attemptsLeft = counted.maxAttempts - counted.attempts;
    if (attemptsLeft <= 0) {
      await this.col.updateOne({ _id: challengeId, status: 'pending' }, { $set: { status: 'locked' } });
      throw errors.locked('OTP_LOCKED', 'Trop de tentatives. Demande un nouveau code.');
    }
    throw new AppError(400, 'OTP_INVALID', 'Code incorrect.', { attemptsLeft });
  }

  /** Single use: the token's challenge moves verified → consumed inside the caller's transaction. */
  async consume(token: string, purpose: OtpPurpose, session?: ClientSession): Promise<{ phone: string }> {
    const claims = await this.tokens.verifyVerification(token);
    if (!claims || claims.purpose !== purpose) throw errors.gone('VERIFICATION_EXPIRED', 'La vérification a expiré. Recommence.');
    const res = await this.col.updateOne(
      { _id: new ObjectId(claims.challengeId), status: 'verified', phone: claims.phone, purpose },
      { $set: { status: 'consumed' } },
      { session },
    );
    if (res.modifiedCount !== 1) throw errors.gone('VERIFICATION_EXPIRED', 'La vérification a expiré. Recommence.');
    return { phone: claims.phone };
  }

  private async deliver(doc: OtpChallengeDoc, code: string) {
    const job: OtpJob = { challengeId: doc._id.toHexString(), phone: doc.phone, code, channel: doc.channel, purpose: doc.purpose };
    // The code travels through Redis once and is deleted as soon as the job completes.
    await this.queues.add(OTP_QUEUE, job, {
      jobId: `${doc._id.toHexString()}-${doc.sendCount}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: true,
      removeOnFail: { age: 3600 },
    });
  }

  private publicView(doc: OtpChallengeDoc) {
    return {
      challengeId: doc._id.toHexString(),
      expiresIn: Math.round((doc.expiresAt.getTime() - this.clock.now().getTime()) / 1000),
      resendAfter: OTP_RESEND_DELAY_S,
      codeLength: this.config.OTP_LENGTH,
      // Development only (refused in production): the fixed code, so the app can show it; absent once codes are real.
      ...(this.config.OTP_DEV_MODE ? { devCode: this.newCode() } : {}),
    };
  }
}
