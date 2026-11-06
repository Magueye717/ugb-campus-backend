import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { SignJWT, exportJWK, jwtVerify, errors as joseErrors } from 'jose';

import type { Config } from '../../config/env.js';
import type { Clock } from '../clock.js';

// Kept from the first name (UGB Campus): every session and ticket QR already issued carries it.
const ISSUER = 'ugb-campus';

export type AccessClaims = { sub: string; sid: string; roles: string[]; /** Expiry, seconds since epoch: long-lived connections (WebSocket) close then. */ exp: number };
export type VerificationPurpose = 'register' | 'reset_password' | 'change_phone';
export type VerificationClaims = { phone: string; purpose: VerificationPurpose; challengeId: string };
/** What a ticket QR code says: which ticket, for which event, at which version (a transfer bumps it). */
export type TicketClaims = { ticketId: string; eventId: string; version: number };

/** EdDSA JWTs: short-lived access tokens, and single-use OTP verification tokens. */
export class TokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(
    private readonly config: Pick<Config, 'jwt' | 'JWT_KID' | 'ACCESS_TOKEN_TTL_S' | 'isProduction'>,
    private readonly clock: Clock,
    private readonly onEphemeralKeys: () => void = () => {},
  ) {
    if (config.jwt.privateKeyPem && config.jwt.publicKeyPem) {
      this.privateKey = createPrivateKey(config.jwt.privateKeyPem);
      this.publicKey = createPublicKey(config.jwt.publicKeyPem);
    } else {
      // Development without keys: tokens die with the process. Production refuses this in loadConfig.
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
      this.onEphemeralKeys();
    }
  }

  get accessTtlS() {
    return this.config.ACCESS_TOKEN_TTL_S;
  }

  private nowS() {
    return Math.floor(this.clock.now().getTime() / 1000);
  }

  async signAccess(c: Omit<AccessClaims, 'exp'>): Promise<{ token: string; expiresAt: Date }> {
    const iat = this.nowS();
    const exp = iat + this.config.ACCESS_TOKEN_TTL_S;
    const token = await new SignJWT({ sid: c.sid, roles: c.roles })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.config.JWT_KID })
      .setIssuer(ISSUER).setAudience('access').setSubject(c.sub).setIssuedAt(iat).setExpirationTime(exp)
      .sign(this.privateKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async verifyAccess(token: string): Promise<AccessClaims | null> {
    const payload = await this.verify(token, 'access');
    if (!payload?.sub || typeof payload.sid !== 'string') return null;
    return { sub: payload.sub, sid: payload.sid, roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [], exp: Number(payload.exp ?? 0) };
  }

  async signVerification(c: VerificationClaims, ttlS = 15 * 60): Promise<string> {
    const iat = this.nowS();
    return new SignJWT({ phone: c.phone, purpose: c.purpose })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.config.JWT_KID })
      .setIssuer(ISSUER).setAudience('verification').setJti(c.challengeId).setIssuedAt(iat).setExpirationTime(iat + ttlS)
      .sign(this.privateKey);
  }

  async verifyVerification(token: string): Promise<VerificationClaims | null> {
    const p = await this.verify(token, 'verification');
    if (!p?.jti || typeof p.phone !== 'string' || !['register', 'reset_password', 'change_phone'].includes(p.purpose as string)) return null;
    return { phone: p.phone, purpose: p.purpose as VerificationPurpose, challengeId: p.jti };
  }

  /**
   * Ticket QR codes: signed by the server, checkable by anyone with the public key (offline scanning later).
   * No personal data inside; no expiry (a ticket stays valid until cancelled or transferred).
   */
  async signTicket(c: TicketClaims): Promise<string> {
    return new SignJWT({ e: c.eventId, v: c.version })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.config.JWT_KID })
      .setIssuer(ISSUER).setAudience('ticket').setSubject(c.ticketId).setIssuedAt(this.nowS())
      .sign(this.privateKey);
  }

  /**
   * The public key ticket QR codes are checked with, for scanners working offline (Ed25519 `x`, base64url).
   * Public by nature: it can only verify, never sign.
   */
  async ticketKey(): Promise<{ kid: string; alg: 'EdDSA'; x: string }> {
    const jwk = await exportJWK(this.publicKey);
    return { kid: this.config.JWT_KID, alg: 'EdDSA', x: jwk.x! };
  }

  async verifyTicket(token: string): Promise<TicketClaims | null> {
    const p = await this.verify(token, 'ticket');
    if (!p?.sub || typeof p.e !== 'string' || typeof p.v !== 'number') return null;
    return { ticketId: p.sub, eventId: p.e, version: p.v };
  }

  private async verify(token: string, audience: string) {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, { issuer: ISSUER, audience, algorithms: ['EdDSA'], currentDate: this.clock.now() });
      return payload;
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) return null;
      throw err;
    }
  }
}
