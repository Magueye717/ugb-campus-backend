import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, json, nextPhone, type TestApp } from './harness.js';

// Real limits (scale 1): the per-IP limits are shared through Redis, so they hold across API instances.
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ RATE_LIMIT_SCALE: '1' });
});
afterAll(async () => {
  await t.close();
});

describe('rate limits', () => {
  it('limits the availability check to 10 per hour per IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await t.app.inject({ method: 'POST', url: '/api/v1/auth/register/check', payload: { phone: nextPhone(), studentNumber: 'P123456' } })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('limits OTP requests per phone number (SMS pumping)', async () => {
    const phone = nextPhone();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/otp', payload: { phone, purpose: 'register' } });
      codes.push(res.statusCode);
      if (res.statusCode === 429) expect(json(res).code).toBe('TOO_MANY_REQUESTS');
    }
    expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
  });
});
