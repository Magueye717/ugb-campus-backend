import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, registerStudent, type TestApp } from '../../../../test/harness.js';

let t: TestApp;
let admin: Awaited<ReturnType<typeof createStaff>>;
beforeAll(async () => {
  t = await createTestApp();
  admin = await createStaff(t, ['admin']);
});
afterAll(async () => {
  await t.close();
});

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token: string, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(token), payload });

let slugSeq = 0;
async function createOrg() {
  const res = await call('POST', '/admin/organizations', admin.tokens.accessToken, { slug: `org-${++slugSeq}`, name: `Transport ${slugSeq}`, category: 'Transporteur', capabilities: ['caravans'] });
  expect(res.statusCode).toBe(201);
  return json(res).id as string;
}

describe('admin back office', () => {
  it('is closed to students and to anonymous callers', async () => {
    const s = await registerStudent(t);
    expect((await call('GET', '/admin/organizations', s.tokens.accessToken)).statusCode).toBe(403);
    expect((await t.app.inject({ url: '/api/v1/admin/organizations' })).statusCode).toBe(401);
  });

  it('a revoked platform role stops working on the next request', async () => {
    const other = await createStaff(t, ['admin']);
    expect((await call('GET', '/admin/organizations', other.tokens.accessToken)).statusCode).toBe(200);
    await call('PUT', `/admin/users/${other.userId.toHexString()}/platform-roles`, admin.tokens.accessToken, { roles: [] });
    expect((await call('GET', '/admin/organizations', other.tokens.accessToken)).statusCode).toBe(403);
  });
});

describe('spaces and organizer roles', () => {
  it('a student who is made organizer gets both spaces in /me', async () => {
    const s = await registerStudent(t);
    const orgId = await createOrg();
    expect(json(await call('GET', '/me', s.tokens.accessToken)).spaces).toEqual(['student']);
    expect((await call('PUT', `/admin/organizations/${orgId}/members`, admin.tokens.accessToken, { phone: s.phone, roles: ['owner'] })).statusCode).toBe(204);
    const me = json(await call('GET', '/me', s.tokens.accessToken));
    expect(me.spaces).toEqual(['student', 'organizer']);
    expect(me.organizations[0]).toMatchObject({ id: orgId, roles: ['owner'] });
  });

  it('an organizer-only account has no student space and cannot use student routes', async () => {
    const staff = await createStaff(t);
    const orgId = await createOrg();
    await call('PUT', `/admin/organizations/${orgId}/members`, admin.tokens.accessToken, { phone: staff.phone, roles: ['scanner'] });
    expect(json(await call('GET', '/me', staff.tokens.accessToken)).spaces).toEqual(['organizer']);
    expect((await call('PATCH', '/me/student-profile', staff.tokens.accessToken, { onCampus: false })).statusCode).toBe(403);
  });

  it('another organization’s space answers 404, not 403', async () => {
    const owner = await registerStudent(t);
    const mine = await createOrg();
    const theirs = await createOrg();
    await call('PUT', `/admin/organizations/${mine}/members`, admin.tokens.accessToken, { phone: owner.phone, roles: ['owner'] });
    expect((await call('GET', `/org/${mine}`, owner.tokens.accessToken)).statusCode).toBe(200);
    expect((await call('GET', `/org/${theirs}`, owner.tokens.accessToken)).statusCode).toBe(404);
    expect((await call('GET', `/org/${theirs}/members`, owner.tokens.accessToken)).statusCode).toBe(404);
  });

  it('owners manage their team but cannot appoint owners; scanners cannot manage the team', async () => {
    const owner = await registerStudent(t);
    const scanner = await registerStudent(t);
    const orgId = await createOrg();
    await call('PUT', `/admin/organizations/${orgId}/members`, admin.tokens.accessToken, { phone: owner.phone, roles: ['owner'] });

    expect((await call('PUT', `/org/${orgId}/members`, owner.tokens.accessToken, { phone: scanner.phone, roles: ['owner'] })).statusCode).toBe(403);
    expect((await call('PUT', `/org/${orgId}/members`, owner.tokens.accessToken, { phone: scanner.phone, roles: ['scanner'] })).statusCode).toBe(204);
    expect((await call('GET', `/org/${orgId}`, scanner.tokens.accessToken)).statusCode).toBe(200);
    expect((await call('GET', `/org/${orgId}/members`, scanner.tokens.accessToken)).statusCode).toBe(404);

    const members = json(await call('GET', `/org/${orgId}/members`, owner.tokens.accessToken));
    expect(members).toHaveLength(2);
    expect(members[0]).not.toHaveProperty('phone');

    await call('DELETE', `/org/${orgId}/members/${scanner.userId}`, owner.tokens.accessToken);
    expect((await call('GET', `/org/${orgId}`, scanner.tokens.accessToken)).statusCode).toBe(404);
  });

  it('suspending an organization closes its space for every member', async () => {
    const owner = await registerStudent(t);
    const orgId = await createOrg();
    await call('PUT', `/admin/organizations/${orgId}/members`, admin.tokens.accessToken, { phone: owner.phone, roles: ['owner'] });
    await call('PATCH', `/admin/organizations/${orgId}`, admin.tokens.accessToken, { status: 'suspended' });
    expect((await call('GET', `/org/${orgId}`, owner.tokens.accessToken)).statusCode).toBe(404);
    expect(json(await call('GET', '/me', owner.tokens.accessToken)).spaces).toEqual(['student']);
  });

  it('stores the category, the contact e-mail and an empty logo; the owner can update the e-mail', async () => {
    const created = await call('POST', '/admin/organizations', admin.tokens.accessToken, {
      slug: 'resto-fatou', name: 'Chez Fatou', category: 'Restaurant', capabilities: ['restaurant'], email: ' Contact@ChezFatou.SN ',
    });
    expect(created.statusCode).toBe(201);
    const org = json(created);
    expect(org).toMatchObject({ category: 'Restaurant', email: 'contact@chezfatou.sn', logoUrl: null });
    expect(org).not.toHaveProperty('kind');

    const owner = await registerStudent(t);
    const outsider = await registerStudent(t);
    await call('PUT', `/admin/organizations/${org.id}/members`, admin.tokens.accessToken, { phone: owner.phone, roles: ['owner'] });

    const patched = await call('PATCH', `/org/${org.id}`, owner.tokens.accessToken, { email: 'commandes@chezfatou.sn' });
    expect(patched.statusCode).toBe(200);
    expect(json(patched).email).toBe('commandes@chezfatou.sn');
    expect((await call('PATCH', `/org/${org.id}`, owner.tokens.accessToken, { email: 'pas-une-adresse' })).statusCode).toBe(400);
    expect((await call('PATCH', `/org/${org.id}`, outsider.tokens.accessToken, { email: 'x@y.sn' })).statusCode).toBe(404);

    // The admin can remove it.
    expect(json(await call('PATCH', `/admin/organizations/${org.id}`, admin.tokens.accessToken, { email: null })).email).toBeNull();
  });

  it('refuses the old "kind" field and unknown categories', async () => {
    const legacy = await call('POST', '/admin/organizations', admin.tokens.accessToken, { slug: 'old-api', name: 'Old API', kind: 'Entreprise', capabilities: ['caravans'] });
    expect(legacy.statusCode).toBe(400);
    const unknown = await call('POST', '/admin/organizations', admin.tokens.accessToken, { slug: 'bad-cat', name: 'Bad', category: 'Banque', capabilities: ['caravans'] });
    expect(unknown.statusCode).toBe(400);
  });

  it('audits membership changes', async () => {
    const s = await registerStudent(t);
    const orgId = await createOrg();
    await call('PUT', `/admin/organizations/${orgId}/members`, admin.tokens.accessToken, { phone: s.phone, roles: ['manager'] });
    const entry = await t.c.mongo.db.collection('auditLogs').findOne({ action: 'membership.set', 'target.id': orgId });
    expect(entry?.actor).toMatchObject({ type: 'user', id: admin.userId.toHexString() });
  });
});
