import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { ObjectId } from 'mongodb';

import { buildApp } from '../src/app.js';
import type { PlatformRole } from '../src/modules/accounts/accounts.types.js';
import { migrateDatabase } from '../src/collections.js';
import { loadConfig } from '../src/config/env.js';
import { createContainer, type Container } from '../src/container.js';
import type { CardReader } from '../src/modules/lost/index.js';
import { FakeClock } from '../src/platform/clock.js';
import { hashPassword } from '../src/platform/security/passwords.js';

export const MONGO_TEST_URI = process.env.MONGODB_TEST_URI ?? 'mongodb://localhost:27018/?replicaSet=rs0';
export const T0 = Date.parse('2026-10-31T10:00:00Z');

/** OCR in tests: returns the text the test sets, never starts Tesseract. */
export class FakeCardReader implements CardReader {
  text = '';
  async read() {
    return this.text;
  }
  async close() {}
}

export type TestApp = {
  app: FastifyInstance;
  c: Container;
  clock: FakeClock;
  ocr: FakeCardReader;
  close(): Promise<void>;
};

/** A full app on its own database and Redis prefix, with a clock that only moves when the test says so. */
export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const id = randomUUID().slice(0, 8);
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: MONGO_TEST_URI,
    MONGODB_DB: `ugb_test_${id}`,
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    REDIS_PREFIX: `test:${id}`,
    OTP_DEV_MODE: 'true',
    OTP_LENGTH: '4',
    RATE_LIMIT_SCALE: '1000',
    ...env,
  });
  const clock = new FakeClock(T0);
  const ocr = new FakeCardReader();
  const c = await createContainer(config, { clock, cardReader: ocr });
  await migrateDatabase(c.mongo.db);
  const app = await buildApp(c);
  await app.ready();
  return {
    app,
    c,
    clock,
    ocr,
    async close() {
      await app.close();
      await c.mongo.db.dropDatabase();
      const keys = await c.redis.keys(`test:${id}:*`);
      if (keys.length) await c.redis.del(...keys);
      await c.close();
    },
  };
}

export const json = (res: { body: string }) => JSON.parse(res.body);

let phoneSeq = 0;
/** Unique valid Senegalese numbers / student numbers per call. */
export const nextPhone = () => `77${String(1000000 + (process.pid % 1000) * 1000 + ++phoneSeq).slice(-7)}`;
export const nextStudentNumber = () => `P${String(100000 + (process.pid % 500) * 1000 + phoneSeq).slice(-6)}`;

export const DEFAULT_PASSWORD = 'Bonjour2026';

/** Runs the real sign-up: OTP request, verify (dev code 1234), register. */
export async function registerStudent(t: TestApp, over: Partial<{ phone: string; studentNumber: string; password: string; campus: 'campus1' | 'campus2'; ufr: string; region: string; firstName: string; lastName: string }> = {}) {
  const phone = over.phone ?? nextPhone();
  const studentNumber = over.studentNumber ?? nextStudentNumber();
  const otp = await t.app.inject({ method: 'POST', url: '/api/v1/auth/otp', payload: { phone, purpose: 'register' } });
  const { challengeId } = json(otp);
  const verify = await t.app.inject({ method: 'POST', url: `/api/v1/auth/otp/${challengeId}/verify`, payload: { code: '1234' } });
  const { verificationToken } = json(verify);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      verificationToken, studentNumber, firstName: over.firstName ?? 'Awa', lastName: over.lastName ?? 'Diop', campus: over.campus ?? 'campus1', onCampus: true,
      village: over.campus === 'campus2' ? 'Village H' : 'Village E', room: '214', ufr: over.ufr ?? 'SAT', region: over.region ?? 'Saint-Louis',
      password: over.password ?? DEFAULT_PASSWORD, termsVersion: '2026-01',
    },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = json(res);
  return { phone, studentNumber, userId: body.userId as string, tokens: body.tokens as { accessToken: string; refreshToken: string } };
}

/** A staff account (no student profile) with a password and optional platform roles, logged in directly. */
export async function createStaff(t: TestApp, roles: PlatformRole[] = []) {
  const phone = nextPhone();
  const user = await t.c.modules.accounts.createStaffUser({ phone, firstName: 'Staff', lastName: 'Member' });
  await t.c.modules.accounts.setPassword(user._id, await hashPassword(DEFAULT_PASSWORD));
  if (roles.length) await t.c.modules.accounts.setPlatformRoles(user._id, roles);
  const tokens = await t.c.modules.identity.startSession({ _id: user._id, platformRoles: roles });
  return { phone, userId: user._id as ObjectId, tokens };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
