import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createTestApp, DEFAULT_PASSWORD, json, nextPhone, registerStudent, type TestApp } from '../../../../test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (url: string, payload: object = {}, headers: Record<string, string> = {}) => t.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers });
const me = (token: string) => t.app.inject({ url: '/api/v1/me', headers: bearer(token) });

describe('login', () => {
  it('accepts the phone in any common format, or the student number', async () => {
    const s = await registerStudent(t);
    const local = s.phone;
    for (const identifier of [local, `+221${local}`, `${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5, 7)} ${local.slice(7)}`, s.studentNumber.toLowerCase()]) {
      const res = await post('/auth/login', { identifier, password: DEFAULT_PASSWORD });
      expect(res.statusCode, identifier).toBe(200);
    }
  });

  it('tells an unknown account apart from a wrong password', async () => {
    const s = await registerStudent(t);
    const wrong = await post('/auth/login', { identifier: s.phone, password: 'Mauvais2026' });
    expect(wrong.statusCode).toBe(401);
    expect(json(wrong)).toMatchObject({ code: 'WRONG_PASSWORD', message: 'Mot de passe incorrect.' });
    for (const identifier of [nextPhone(), 'P999999']) {
      const unknown = await post('/auth/login', { identifier, password: 'Mauvais2026' });
      expect(unknown.statusCode, identifier).toBe(404);
      expect(json(unknown)).toMatchObject({ code: 'ACCOUNT_NOT_FOUND', message: 'Aucun compte sur ce numéro.' });
    }
  });

  it('locks the account progressively after 5 wrong passwords, even for the right one', async () => {
    const s = await registerStudent(t);
    for (let i = 0; i < 5; i++) expect((await post('/auth/login', { identifier: s.phone, password: 'Mauvais2026' })).statusCode).toBe(401);
    const locked = await post('/auth/login', { identifier: s.phone, password: DEFAULT_PASSWORD });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    t.clock.advance(61_000);
    expect((await post('/auth/login', { identifier: s.phone, password: DEFAULT_PASSWORD })).statusCode).toBe(200);
  });

  it('rejects query operators instead of passing them to MongoDB', async () => {
    for (const payload of [{ identifier: { $gt: '' }, password: 'x' }, { identifier: 'P123456', password: { $ne: null } }]) {
      expect((await post('/auth/login', payload)).statusCode).toBe(400);
    }
  });
});

describe('sessions', () => {
  it('rotates the refresh token on every use', async () => {
    const s = await registerStudent(t);
    const r1 = json(await post('/auth/refresh', { refreshToken: s.tokens.refreshToken }));
    expect(r1.refreshToken).not.toBe(s.tokens.refreshToken);
    expect((await me(r1.accessToken)).statusCode).toBe(200);
    const r2 = await post('/auth/refresh', { refreshToken: r1.refreshToken });
    expect(r2.statusCode).toBe(200);
  });

  it('replaying a used refresh token revokes the whole login, including the live access token', async () => {
    const s = await registerStudent(t);
    const r1 = json(await post('/auth/refresh', { refreshToken: s.tokens.refreshToken }));
    expect((await post('/auth/refresh', { refreshToken: s.tokens.refreshToken })).statusCode).toBe(401); // stolen token replayed
    expect((await post('/auth/refresh', { refreshToken: r1.refreshToken })).statusCode).toBe(401);
    expect((await me(r1.accessToken)).statusCode).toBe(401);
  });

  it('logout-all ends every session at once', async () => {
    const s = await registerStudent(t);
    const other = json(await post('/auth/login', { identifier: s.phone, password: DEFAULT_PASSWORD })).tokens;
    expect((await post('/auth/logout-all', {}, bearer(s.tokens.accessToken))).statusCode).toBe(204);
    expect((await me(s.tokens.accessToken)).statusCode).toBe(401);
    expect((await me(other.accessToken)).statusCode).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: other.refreshToken })).statusCode).toBe(401);
  });

  it('logout only accepts the caller’s own refresh token', async () => {
    const a = await registerStudent(t);
    const b = await registerStudent(t);
    await post('/auth/logout', { refreshToken: b.tokens.refreshToken }, bearer(a.tokens.accessToken));
    expect((await post('/auth/refresh', { refreshToken: b.tokens.refreshToken })).statusCode).toBe(200);
  });

  it('access tokens expire after 15 minutes', async () => {
    const s = await registerStudent(t);
    t.clock.advance(15 * 60_000 + 1000);
    expect((await me(s.tokens.accessToken)).statusCode).toBe(401);
  });

  it('changing the password keeps the current session and ends the others', async () => {
    const s = await registerStudent(t);
    const other = json(await post('/auth/login', { identifier: s.phone, password: DEFAULT_PASSWORD })).tokens;
    const res = await t.app.inject({ method: 'PUT', url: '/api/v1/auth/password', headers: bearer(s.tokens.accessToken), payload: { currentPassword: DEFAULT_PASSWORD, newPassword: 'Nouveau2026' } });
    expect(res.statusCode).toBe(204);
    expect((await me(s.tokens.accessToken)).statusCode).toBe(200);
    expect((await me(other.accessToken)).statusCode).toBe(401);
  });

  it('rejects forged or malformed tokens', async () => {
    const s = await registerStudent(t);
    const [h, p] = s.tokens.accessToken.split('.');
    const forged = `${h}.${p}.${'A'.repeat(86)}`;
    for (const token of [forged, 'not-a-jwt', '']) expect((await me(token)).statusCode).toBe(401);
  });
});
