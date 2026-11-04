import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createTestApp, json, registerStudent, type TestApp } from '../../../../test/harness.js';
import { multipart, picture } from '../../../../test/upload.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ MEDIA_DIR: mkdtempSync(join(tmpdir(), 'ugb-media-')) });
});
afterAll(async () => t.close());

const upload = async (token: string, file: Buffer, name = 'photo.png', type = 'image/png', purpose = 'banner') => {
  const body = multipart(file, name, type);
  return t.app.inject({ method: 'POST', url: `/api/v1/media/images?purpose=${purpose}`, headers: { ...bearer(token), ...body.headers }, payload: body.payload });
};
const avatarUpload = async (token: string) => json(await upload(token, await picture(), 'me.png', 'image/png', 'avatar')) as { id: string; url: string };
const served = async (url: string) => (await t.app.inject({ url: new URL(url).pathname })).statusCode;
const setAvatar = (token: string, photoId: string | null) => t.app.inject({ method: 'PUT', url: '/api/v1/me/avatar', headers: bearer(token), payload: { photoId } });

describe('image upload', () => {
  it('re-encodes to WebP, at most 1600 px, served back; the uploader alone can attach it', async () => {
    const s = await registerStudent(t);
    const res = await upload(s.tokens.accessToken, await picture(3000, 2000, 'jpeg'), 'IMG_0001.jpg', 'image/jpeg');
    expect(res.statusCode, res.body).toBe(201);
    const img = json(res);
    expect(img).toMatchObject({ width: 1600, height: 1067 });
    expect(img.url).toMatch(/\/api\/v1\/media\/banner\/\d{4}\/\d{2}\/[a-f0-9]{24}\.webp$/);
    const file = await t.app.inject({ url: new URL(img.url).pathname });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/webp');
    expect((await sharp(file.rawPayload).metadata()).format).toBe('webp');

    expect(await t.c.modules.media.claim(new ObjectId(s.userId), [img.id])).toEqual([{ mediaId: new ObjectId(img.id), url: img.url }]);
    const other = await registerStudent(t);
    await expect(t.c.modules.media.claim(new ObjectId(other.userId), [img.id])).rejects.toMatchObject({ status: 400 });
  });

  it('refuses what isn’t a picture, tiny pictures, and anonymous uploads', async () => {
    const s = await registerStudent(t);
    expect((await upload(s.tokens.accessToken, Buffer.from('%PDF-1.4 not an image'), 'cv.png')).statusCode).toBe(400);
    expect(json(await upload(s.tokens.accessToken, await picture(100, 80))).message).toContain('trop petite');
    const body = multipart(await picture());
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/media/images?purpose=banner', headers: body.headers, payload: body.payload })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/v1/media/../../etc/passwd' })).statusCode).toBe(404);
  });
});

describe('old pictures leave the storage', () => {
  it('a replaced or removed profile picture is deleted, the new one stays', async () => {
    const s = await registerStudent(t);
    const first = await avatarUpload(s.tokens.accessToken);
    expect((await setAvatar(s.tokens.accessToken, first.id)).statusCode).toBe(204);
    const second = await avatarUpload(s.tokens.accessToken);
    expect((await setAvatar(s.tokens.accessToken, second.id)).statusCode).toBe(204);
    expect(await served(first.url)).toBe(404);
    expect(await t.c.mongo.db.collection('media').countDocuments({ _id: new ObjectId(first.id) })).toBe(0);
    expect(await served(second.url)).toBe(200);

    // Saving the same picture again keeps it.
    expect((await setAvatar(s.tokens.accessToken, second.id)).statusCode).toBe(204);
    expect(await served(second.url)).toBe(200);

    expect((await setAvatar(s.tokens.accessToken, null)).statusCode).toBe(204);
    expect(await served(second.url)).toBe(404);
  });

  it('a picture still used somewhere else is kept', async () => {
    const s = await registerStudent(t);
    const pic = await avatarUpload(s.tokens.accessToken);
    await setAvatar(s.tokens.accessToken, pic.id);
    expect(await t.c.modules.media.release([new ObjectId(pic.id)])).toBe(0);
    expect(await served(pic.url)).toBe(200);
  });

  it('the hourly sweep deletes uploads never attached after a day, and keeps what is in use', async () => {
    const s = await registerStudent(t);
    const used = await avatarUpload(s.tokens.accessToken);
    await setAvatar(s.tokens.accessToken, used.id);
    const abandoned = await avatarUpload(s.tokens.accessToken);

    expect(await t.c.modules.media.service.sweep()).toBe(0); // too recent: the form may still be saved
    expect(await served(abandoned.url)).toBe(200);

    t.clock.advance(25 * 3600_000);
    await t.c.modules.media.service.sweep();
    expect(await served(abandoned.url)).toBe(404);
    expect(await served(used.url)).toBe(200);
    expect(await t.c.mongo.db.collection('media').findOne({ _id: new ObjectId(used.id) })).toMatchObject({ checkedAt: t.clock.now() });
  });
});
