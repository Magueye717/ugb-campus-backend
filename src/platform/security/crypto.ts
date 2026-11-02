import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const hmac = (key: string, value: string) => createHmac('sha256', key).update(value).digest('hex');

/** Opaque, URL-safe random token (refresh tokens). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Numeric code with a uniform distribution (OTP). */
export const randomDigits = (length: number) => Array.from({ length }, () => randomInt(0, 10)).join('');

/** Crockford base32 without ambiguous letters: ticket and order codes people read aloud or type. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const randomCode = (length: number) => Array.from({ length }, () => CROCKFORD[randomInt(0, 32)]).join('');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
