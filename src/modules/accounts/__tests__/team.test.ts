import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, nextPhone, registerStudent, type TestApp } from '../../../../test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

type Who = { userId: string | ObjectId };
async function call(who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
  const { accessToken } = await t.c.modules.identity.startSession({ _id: new ObjectId(String(who.userId)), platformRoles: [] });
  return t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(accessToken), payload });
}
const login = (identifier: string, password: string) => t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier, password } });

describe('the super admin’s team', () => {
  it('only the super admin gives roles: two steps, the person is told; removed, they can’t sign in', async () => {
    const admin = await createStaff(t, ['admin']);
    const editor = await createStaff(t, ['content_editor']);
    const phone = nextPhone();
    expect((await call(editor, 'GET', '/admin/team')).statusCode).toBe(403);

    expect(json(await call(admin, 'POST', '/admin/team/lookup', { phone }))).toEqual({ exists: false });
    expect(json(await call(admin, 'PUT', '/admin/team', { phone, roles: ['place_editor', 'shop_editor'] })).code).toBe('USER_NOT_FOUND');
    expect((await call(admin, 'PUT', '/admin/team', { phone, roles: ['place_editor', 'shop_editor'], firstName: 'Ndeye', lastName: 'Fall', password: 'Campus2026' })).statusCode).toBe(204);
    // A menu publisher needs their restaurants.
    expect(json(await call(admin, 'PUT', '/admin/team', { phone, roles: ['resto_u_staff'] })).field).toBe('restoIds');

    const team = json(await call(admin, 'GET', '/admin/team'));
    expect(team.items.find((m: { firstName: string }) => m.firstName === 'Ndeye')).toMatchObject({ roles: ['place_editor', 'shop_editor'], restos: [] });
    expect(team.roles.find((r: { value: string }) => r.value === 'place_editor')).toEqual({ value: 'place_editor', label: 'Lieux', space: 'Référencement' });

    const signed = await login(phone, 'Campus2026');
    expect(signed.statusCode).toBe(200);
    const ndeye = { userId: json(signed).userId as string };
    const me = json(await call(ndeye, 'GET', '/me'));
    expect(me.spaces.map((s: { key: string }) => s.key)).toEqual(['directory']);
    expect(json(await call(ndeye, 'GET', '/notifications')).items.map((n: { type: string }) => n.type)).toContain('team.role_added');

    // Never removes themself.
    expect((await call(admin, 'DELETE', `/admin/team/${admin.userId.toHexString()}`)).statusCode).toBe(403);
    expect((await call(admin, 'DELETE', `/admin/team/${ndeye.userId}`)).statusCode).toBe(204);
    const told = await call({ userId: ndeye.userId }, 'GET', '/notifications');
    expect(json(told).items.map((n: { type: string }) => n.type)).toContain('team.role_removed');
    expect(json(await login(phone, 'Campus2026')).code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('a student in the team keeps their student space when removed', async () => {
    const admin = await createStaff(t, ['admin']);
    const s = await registerStudent(t);
    expect((await call(admin, 'PUT', '/admin/team', { phone: s.phone, roles: ['content_editor'] })).statusCode).toBe(204);
    expect(json(await call(s, 'GET', '/me')).spaces.map((x: { key: string }) => x.key)).toEqual(['student', 'alerts']);
    expect((await call(admin, 'DELETE', `/admin/team/${s.userId}`)).statusCode).toBe(204);
    expect(json(await call(s, 'GET', '/me')).spaces.map((x: { key: string }) => x.key)).toEqual(['student']);
  });
});
