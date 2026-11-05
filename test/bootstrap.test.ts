import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { allDataMigrations, migrateDatabase } from '../src/collections.js';
import { ensureBootstrapAdmin } from '../src/modules/accounts/index.js';
import { CAMPUS_PLACES } from '../src/modules/places/places.catalog.js';
import { CAMPUS_RESTOS } from '../src/modules/public-restos/public-restos.catalog.js';
import { verifyPassword } from '../src/platform/security/passwords.js';
import { createTestApp, json, type TestApp } from './harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

const admin = { phone: '770000000', password: 'Caampus2026', firstName: 'Admin', lastName: 'Campus' };

describe('deploy bootstrap', () => {
  it('creates the first administrator once, then never touches the account again', async () => {
    const db = t.c.mongo.db;
    expect(await ensureBootstrapAdmin(db, t.clock, admin)).toBe('created');
    const user = await db.collection('users').findOne({ phone: '+221770000000' });
    expect(user).toMatchObject({ platformRoles: ['admin'], status: 'active' });

    const login = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: '770000000', password: 'Caampus2026' } });
    expect(login.statusCode, login.body).toBe(200);
    expect(json(login).tokens.accessToken).toBeTruthy();

    // A later deploy with another password: the account keeps its own.
    expect(await ensureBootstrapAdmin(db, t.clock, { ...admin, password: 'Different2027' })).toBe('exists');
    const again = await db.collection('users').findOne({ phone: '+221770000000' });
    expect(await verifyPassword(again!.passwordHash, 'Caampus2026')).toBe(true);
    expect(await db.collection('users').countDocuments({ phone: '+221770000000' })).toBe(1);
  });

  it('adds the campus places once: a place the team deletes does not come back', async () => {
    const places = t.c.mongo.db.collection('places');
    expect(await places.countDocuments()).toBe(CAMPUS_PLACES.length);
    await places.deleteOne({ name: CAMPUS_PLACES[0]!.name });
    await migrateDatabase(t.c.mongo.db); // the next deploy
    expect(await places.countDocuments()).toBe(CAMPUS_PLACES.length - 1);
    expect(allDataMigrations.some((m) => m.id === '2026-11-05-campus-places')).toBe(true);
  });

  it('adds Resto 1 and Resto 2 once, without menus: an archived one stays archived', async () => {
    const restos = t.c.mongo.db.collection('publicRestos');
    expect((await restos.find({}).sort({ sortOrder: 1 }).toArray()).map((r) => [r.slug, r.name, r.status])).toEqual(CAMPUS_RESTOS.map((r) => [r.slug, r.name, 'active']));
    expect(await t.c.mongo.db.collection('publicMenus').countDocuments()).toBe(0);
    await restos.updateOne({ slug: 'resto-2' }, { $set: { status: 'archived' } });
    await migrateDatabase(t.c.mongo.db);
    expect(await restos.countDocuments()).toBe(2);
    expect(await restos.findOne({ slug: 'resto-2' })).toMatchObject({ status: 'archived' });
  });
});
