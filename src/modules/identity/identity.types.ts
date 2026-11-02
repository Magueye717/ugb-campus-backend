import type { ObjectId } from 'mongodb';

export type OtpPurpose = 'register' | 'reset_password';
export type OtpChannel = 'sms' | 'whatsapp' | 'email';

export type OtpChallengeDoc = {
  _id: ObjectId;
  purpose: OtpPurpose;
  phone: string;
  /** HMAC(code, pepper); the code itself is never stored. */
  codeHash: string;
  attempts: number;
  maxAttempts: number;
  sendCount: number;
  lastSentAt: Date;
  channel: OtpChannel;
  /** `consumed` once its verification token has been used (single use). */
  status: 'pending' | 'verified' | 'consumed' | 'locked';
  expiresAt: Date;
  /** TTL index: removed a day after expiry (kept for abuse analysis meanwhile). */
  purgeAt: Date;
  ip: string;
  createdAt: Date;
};

export type SessionDoc = {
  _id: ObjectId;
  userId: ObjectId;
  /** All rotations of one login share a family; reuse of a rotated token revokes the whole family. */
  familyId: ObjectId;
  familyStartedAt: Date;
  tokenHash: string;
  status: 'active' | 'rotated' | 'revoked';
  replacedBy: ObjectId | null;
  device: { id: string | null; platform: string | null; appVersion: string | null };
  ip: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
};

export type DeviceInfo = { id?: string; platform?: string; appVersion?: string };

export type Tokens = { accessToken: string; accessTokenExpiresAt: string; refreshToken: string; refreshTokenExpiresAt: string };
