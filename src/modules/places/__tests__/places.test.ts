import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, registerStudent, type TestApp } from '../../../../test/harness.js';
import { multipart, picture } from '../../../../test/upload.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

type Who = { tokens: { accessToken: string } };
const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(who.tokens.accessToken), payload });
const ok = async (res: Promise<{ statusCode: number; body: string }>, status = 200) => {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return json(r);
};

describe('places', () => {
  it('the place editors add, edit and hide places; students see the active ones', async () => {
    const editor = await createStaff(t, ['place_editor']);
    const s = await registerStudent(t);
    // A new database starts with the campus places (places migration): this test works on its own two.
    await t.c.mongo.db.collection('places').deleteMany({});
    await t.c.modules.places.service.seed([{ name: 'Bibliothèque universitaire', category: 'Études', location: { lat: 16.0629, lng: -16.4232 }, photoUrls: ['https://example.com/bu.jpg'] }]);

    expect((await call(s, 'POST', '/admin/places', { name: 'Kiosque', category: 'Services', location: { lat: 16.06, lng: -16.42 } })).statusCode).toBe(403);
    const upload = multipart(await picture());
    const photo = json(await t.app.inject({ method: 'POST', url: '/api/v1/media/images?purpose=place', headers: { ...bearer(editor.tokens.accessToken), ...upload.headers }, payload: upload.payload }));
    const kiosk = await ok(call(editor, 'POST', '/admin/places', { name: 'Kiosque à journaux', category: 'Services', area: 'Entrée', location: { lat: 16.0598, lng: -16.4224 }, hours: '7h-19h', photos: [photo.id] }), 201);
    expect(kiosk).toMatchObject({ icon: 'storefront-outline', photos: [expect.stringMatching(/\.webp$/)], photoRefs: [photo.id], active: true });

    const list = (await ok(call(s, 'GET', '/places'))).items;
    expect(list.map((p: { name: string }) => p.name)).toEqual(['Bibliothèque universitaire', 'Kiosque à journaux']);
    const bu = list[0];
    expect(bu).toMatchObject({ category: 'Études', icon: 'book-outline', photos: ['https://example.com/bu.jpg'], photoRefs: ['https://example.com/bu.jpg'] });

    // A seeded picture kept by its url, a new one added.
    const second = multipart(await picture());
    const photo2 = json(await t.app.inject({ method: 'POST', url: '/api/v1/media/images?purpose=place', headers: { ...bearer(editor.tokens.accessToken), ...second.headers }, payload: second.payload }));
    const edited = await ok(call(editor, 'PATCH', `/admin/places/${bu.id}`, { photos: [photo2.id, 'https://example.com/bu.jpg'], hours: '8h-23h' }));
    expect(edited).toMatchObject({ hours: '8h-23h', photoRefs: [photo2.id, 'https://example.com/bu.jpg'] });
    expect((await call(editor, 'PATCH', `/admin/places/${bu.id}`, { photos: ['https://evil.example/x.jpg'] })).statusCode).toBe(400);

    // Hidden: gone for students, still in the back office.
    await ok(call(editor, 'PATCH', `/admin/places/${kiosk.id}`, { active: false }));
    expect((await ok(call(s, 'GET', '/places'))).items.some((p: { id: string }) => p.id === kiosk.id)).toBe(false);
    expect((await call(s, 'GET', `/places/${kiosk.id}`)).statusCode).toBe(404);
    expect((await ok(call(editor, 'GET', '/admin/places'))).items).toHaveLength(2);
    expect((await call(editor, 'DELETE', `/admin/places/${kiosk.id}`)).statusCode).toBe(204);
  });

  it('the campus outline frames the map', async () => {
    const s = await registerStudent(t);
    const campus = await ok(call(s, 'GET', '/places/campus'));
    expect(campus.attribution).toBe('© OpenStreetMap');
    expect(campus.start).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number), delta: expect.any(Number) });
    expect(campus.outline.length).toBeGreaterThan(10);
    expect(campus.outline[0]).toEqual(campus.outline.at(-1));
    for (const p of campus.outline) {
      expect(p.lat).toBeGreaterThanOrEqual(campus.bounds.south);
      expect(p.lng).toBeLessThanOrEqual(campus.bounds.east);
    }
  });
});
