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

const upload = async (token: string, file: Buffer, name = 'photo.png', type = 'image/png') => {
  const body = multipart(file, name, type);
  return t.app.inject({ method: 'POST', url: '/api/v1/media/images?purpose=banner', headers: { ...bearer(token), ...body.headers }, payload: body.payload });
};

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
