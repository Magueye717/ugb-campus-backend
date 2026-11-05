import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createStaff, createTestApp, json, registerStudent, type TestApp } from '../../../../test/harness.js';
import { multipart, picture } from '../../../../test/upload.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ MEDIA_DIR: mkdtempSync(join(tmpdir(), 'ugb-alerts-')) });
});
afterAll(async () => t.close());

type Who = { tokens: { accessToken: string } };
const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => t.app.inject({ method, url: `/api/v1${url}`, headers: bearer(who.tokens.accessToken), payload });
const send = (who: Who, url: string, file: Buffer, name: string, type: string) => {
  const body = multipart(file, name, type);
  return t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { ...bearer(who.tokens.accessToken), ...body.headers }, payload: body.payload });
};
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const inAWeek = () => new Date(t.clock.now().getTime() + 7 * 24 * 3_600_000).toISOString();

describe('"À la une" with a picture and a PDF', () => {
  it('an announcement has its page: the whole text, a picture and a PDF; replaced files leave the storage', async () => {
    const editor = await createStaff(t, ['content_editor']);
    const s = await registerStudent(t);

    // Only a real PDF, and only for announcements.
    expect((await send(editor, '/media/files?purpose=alert', Buffer.from('not a pdf'), 'x.pdf', 'application/pdf')).statusCode).toBe(400);
    expect((await send(editor, '/media/files?purpose=banner', pdf('a'), 'x.pdf', 'application/pdf')).statusCode).toBe(400);
    const doc = json(await send(editor, '/media/files?purpose=alert', pdf('calendrier'), '../../Calendrier des examens.pdf', 'application/pdf'));
    expect(doc).toMatchObject({ name: 'Calendrier des examens.pdf', url: expect.stringMatching(/\.pdf$/) });
    const file = await t.app.inject({ url: new URL(doc.url).pathname });
    expect(file.headers['content-type']).toBe('application/pdf');
    const image = json(await send(editor, '/media/images?purpose=alert', await picture(), 'affiche.png', 'image/png'));
    // A PDF is not a picture, and a picture is not a document.
    const wrong = await call(editor, 'POST', '/admin/alerts', { placement: 'headline', tag: 'Examens', title: 'Calendrier', body: 'Résumé', endsAt: inAWeek(), imageId: doc.id });
    expect(wrong.statusCode).toBe(400);

    const created = json(
      await call(editor, 'POST', '/admin/alerts', {
        placement: 'headline', tag: 'Examens', title: 'Calendrier des examens', body: 'Du 10 au 21 novembre', details: 'Toutes les UFR. Les salles sont affichées devant le rectorat.',
        endsAt: inAWeek(), imageId: image.id, attachmentId: doc.id,
      }),
    );
    expect(created).toMatchObject({ details: 'Toutes les UFR. Les salles sont affichées devant le rectorat.', image: image.url, attachment: { url: doc.url, name: 'Calendrier des examens.pdf' } });

    const page = await call(s, 'GET', `/alerts/${created.id}`);
    expect(page.statusCode, page.body).toBe(200);
    expect(json(page)).toMatchObject({ title: 'Calendrier des examens', attachment: { name: 'Calendrier des examens.pdf' } });
    expect((await call(s, 'GET', `/alerts/${new ObjectId().toHexString()}`)).statusCode).toBe(404);

    // The PDF replaced, the picture kept (not sent): the old PDF goes, the picture stays.
    const v2 = json(await send(editor, '/media/files?purpose=alert', pdf('v2'), 'Calendrier v2.pdf', 'application/pdf'));
    const updated = json(await call(editor, 'PUT', `/admin/alerts/${created.id}`, { placement: 'headline', tag: 'Examens', title: 'Calendrier des examens', body: 'Mis à jour', endsAt: inAWeek(), attachmentId: v2.id }));
    expect(updated).toMatchObject({ image: image.url, attachment: { name: 'Calendrier v2.pdf' } });
    const media = t.c.mongo.db.collection('media');
    expect(await media.countDocuments({ _id: new ObjectId(doc.id) })).toBe(0);
    expect(await media.countDocuments({ _id: new ObjectId(image.id) })).toBe(1);
  });
});
