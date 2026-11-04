import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createTestApp, json, nextPhone, registerStudent, type TestApp } from '../../../../test/harness.js';
import { multipart, picture } from '../../../../test/upload.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, token: string, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(token), payload });

describe('e-mail address', () => {
  it('starts empty, is added after sign-up normalized and unverified, and can be removed', async () => {
    const s = await registerStudent(t);
    expect(json(await call('GET', '/me', s.tokens.accessToken)).email).toBeNull();

    expect((await call('PUT', '/me/email', s.tokens.accessToken, { email: '  Awa.Diop@UGB.edu.sn ' })).statusCode).toBe(204);
    expect(json(await call('GET', '/me', s.tokens.accessToken)).email).toEqual({ address: 'awa.diop@ugb.edu.sn', verified: false });

    expect((await call('DELETE', '/me/email', s.tokens.accessToken)).statusCode).toBe(204);
    expect(json(await call('GET', '/me', s.tokens.accessToken)).email).toBeNull();
  });

  it('rejects malformed addresses', async () => {
    const s = await registerStudent(t);
    for (const email of ['awa', 'awa@ugb', 'awa diop@ugb.sn', 'a@b.c']) {
      const res = await call('PUT', '/me/email', s.tokens.accessToken, { email });
      expect(res.statusCode, email).toBe(400);
    }
  });

  it('one address per account, whatever the letter case; a freed address can be reused', async () => {
    const a = await registerStudent(t);
    const b = await registerStudent(t);
    await call('PUT', '/me/email', a.tokens.accessToken, { email: 'shared@ugb.edu.sn' });
    const taken = await call('PUT', '/me/email', b.tokens.accessToken, { email: 'SHARED@ugb.edu.sn' });
    expect(taken.statusCode).toBe(409);
    expect(json(taken).code).toBe('EMAIL_TAKEN');

    await call('DELETE', '/me/email', a.tokens.accessToken);
    expect((await call('PUT', '/me/email', b.tokens.accessToken, { email: 'shared@ugb.edu.sn' })).statusCode).toBe(204);
  });

  it('accounts without an address never collide on the unique index', async () => {
    const a = await registerStudent(t);
    const b = await registerStudent(t);
    await call('PUT', '/me/email', a.tokens.accessToken, { email: 'x1@ugb.edu.sn' });
    await call('DELETE', '/me/email', a.tokens.accessToken);
    // Both now have email: null.
    expect(json(await call('GET', '/me', a.tokens.accessToken)).email).toBeNull();
    expect(json(await call('GET', '/me', b.tokens.accessToken)).email).toBeNull();
  });
});

describe('profile picture', () => {
  it('is empty until the media module provides uploads', async () => {
    const s = await registerStudent(t);
    expect(json(await call('GET', '/me', s.tokens.accessToken)).avatarUrl).toBeNull();
  });
});

describe('current location', () => {
  it('stores latitude and longitude as GeoJSON, shows them only to the user, and can be cleared', async () => {
    const s = await registerStudent(t);
    expect(json(await call('GET', '/me', s.tokens.accessToken)).location).toBeNull();

    const res = await call('PUT', '/me/location', s.tokens.accessToken, { lat: 16.0617, lng: -16.4236, accuracyM: 12 });
    expect(res.statusCode).toBe(204);
    expect(json(await call('GET', '/me', s.tokens.accessToken)).location).toEqual({
      lat: 16.0617, lng: -16.4236, accuracyM: 12, updatedAt: new Date(t.clock.now()).toISOString(),
    });

    // Stored [lng, lat] so the 2dsphere index can answer "near me" queries later.
    const near = await t.c.mongo.db
      .collection('users')
      .find({ 'lastLocation.point': { $nearSphere: { $geometry: { type: 'Point', coordinates: [-16.4236, 16.0618] }, $maxDistance: 100 } } })
      .toArray();
    expect(near.map((u) => u._id.toHexString())).toEqual([s.userId]);

    expect((await call('DELETE', '/me/location', s.tokens.accessToken)).statusCode).toBe(204);
    expect(json(await call('GET', '/me', s.tokens.accessToken)).location).toBeNull();
  });

  it('rejects impossible coordinates', async () => {
    const s = await registerStudent(t);
    for (const body of [{ lat: 91, lng: 0 }, { lat: 0, lng: -181 }, { lat: '16', lng: 'x' }, { lat: 16 }]) {
      expect((await call('PUT', '/me/location', s.tokens.accessToken, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('requires a signed-in user', async () => {
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/me/location', payload: { lat: 16, lng: -16 } })).statusCode).toBe(401);
  });
});

describe('phone number and picture', () => {
  it('a new number, proven by its code, replaces the old one for signing in', async () => {
    const s = await registerStudent(t);
    const other = await registerStudent(t);
    const post = (url: string, payload: object) => t.app.inject({ method: 'POST', url: `/api/v1${url}`, payload });
    // A number that already has an account gets no code.
    expect(json(await post('/auth/otp', { phone: other.phone, purpose: 'change_phone' })).code).toBe('PHONE_TAKEN');
    const phone = nextPhone();
    const { challengeId } = json(await post('/auth/otp', { phone, purpose: 'change_phone' }));
    const { verificationToken } = json(await post(`/auth/otp/${challengeId}/verify`, { code: '1234' }));
    expect((await call('PUT', '/me/phone', s.tokens.accessToken, { verificationToken })).statusCode).toBe(204);
    expect((await post('/auth/login', { identifier: phone, password: 'Bonjour2026' })).statusCode).toBe(200);
    expect(json(await post('/auth/login', { identifier: s.phone, password: 'Bonjour2026' })).code).toBe('ACCOUNT_NOT_FOUND');
    // A code is used once.
    expect((await call('PUT', '/me/phone', s.tokens.accessToken, { verificationToken })).statusCode).not.toBe(204);
  });

  it('a profile picture: an upload, then removed', async () => {
    const s = await registerStudent(t);
    const up = multipart(await picture());
    const photo = json(await t.app.inject({ method: 'POST', url: '/api/v1/media/images?purpose=avatar', headers: { ...bearer(s.tokens.accessToken), ...up.headers }, payload: up.payload }));
    expect((await call('PUT', '/me/avatar', s.tokens.accessToken, { photoId: photo.id })).statusCode).toBe(204);
    expect(json(await call('GET', '/me', s.tokens.accessToken)).avatarUrl).toMatch(/\.webp$/);
    expect((await call('PUT', '/me/avatar', s.tokens.accessToken, { photoId: null })).statusCode).toBe(204);
    expect(json(await call('GET', '/me', s.tokens.accessToken)).avatarUrl).toBeNull();
  });
});
