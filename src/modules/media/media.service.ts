import { ObjectId, type Collection, type Db } from 'mongodb';
import sharp, { type Metadata } from 'sharp';

import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import type { ImageRef } from '../../platform/media.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { MediaStorage } from './media.storage.js';
import type { MediaDoc, MediaPurpose } from './media.types.js';

/** Longest side after re-encoding: sharp on a phone, light on mobile data. */
const MAX_SIDE = 1600;
/** Smallest accepted side: a blurry thumbnail makes a bad banner. */
const MIN_SIDE = 320;
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);

export class MediaService {
  private readonly media: Collection<MediaDoc>;

  constructor(
    db: Db,
    private readonly clock: Clock,
    private readonly storage: MediaStorage,
    private readonly limiter: Limiter,
  ) {
    this.media = db.collection('media');
  }

  /**
   * Checks an uploaded picture and keeps a clean copy: the real format is read from the bytes (not the file name),
   * the photo is turned upright, resized, re-encoded to WebP and stripped of its metadata (GPS position…).
   */
  async upload(ownerId: ObjectId, purpose: MediaPurpose, input: Buffer, apiBase: string): Promise<MediaDoc> {
    await this.limiter.hit(`media-upload:${ownerId.toHexString()}`, { limit: 40, windowS: 3600 }, 'Trop d’images envoyées. Réessaie dans une heure.');
    let meta: Metadata;
    try {
      meta = await sharp(input).metadata();
    } catch {
      throw errors.validation('Ce fichier n’est pas une image.', { field: 'file' });
    }
    if (!meta.format || !ACCEPTED.has(meta.format)) throw errors.validation('Formats acceptés : JPEG, PNG, WebP, HEIC.', { field: 'file' });
    if ((meta.width ?? 0) < MIN_SIDE && (meta.height ?? 0) < MIN_SIDE) throw errors.validation(`Image trop petite : au moins ${MIN_SIDE} pixels de côté.`, { field: 'file' });
    const { data, info } = await sharp(input, { failOn: 'error' })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    const now = this.clock.now();
    const _id = new ObjectId();
    const key = `${purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${_id.toHexString()}.webp`;
    await this.storage.put(key, data, 'image/webp');
    const doc: MediaDoc = { _id, ownerId, purpose, key, url: this.storage.url(key, apiBase), contentType: 'image/webp', width: info.width, height: info.height, bytes: info.size, createdAt: now };
    await this.media.insertOne(doc);
    return doc;
  }

  /**
   * The pictures a user attaches to their banner or event: theirs, in the given order. Anything else (another
   * person's upload, a made-up id) is refused.
   */
  async claim(ownerId: ObjectId, ids: string[]): Promise<ImageRef[]> {
    const oids = ids.map((id) => (ObjectId.isValid(id) ? new ObjectId(id) : null));
    if (oids.some((x) => !x)) throw errors.validation('Image inconnue.', { field: 'images' });
    const found = await this.media.find({ _id: { $in: oids as ObjectId[] }, ownerId }).toArray();
    return (oids as ObjectId[]).map((id) => {
      const m = found.find((f) => f._id.equals(id));
      if (!m) throw errors.validation('Image inconnue : envoie-la d’abord.', { field: 'images' });
      return { mediaId: m._id, url: m.url };
    });
  }
}
