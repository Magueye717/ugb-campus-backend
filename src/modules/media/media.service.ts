import { ObjectId, type Collection, type Db } from 'mongodb';
import sharp, { type Metadata } from 'sharp';

import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import type { ImageRef } from '../../platform/media.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { MediaStorage } from './media.storage.js';
import type { MediaDoc, MediaPurpose, MediaUsage } from './media.types.js';

/** Longest side after re-encoding: sharp on a phone, light on mobile data. */
const MAX_SIDE = 1600;
/** Smallest accepted side: a blurry thumbnail makes a bad banner. */
const MIN_SIDE = 320;
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);
/** An upload is attached by a second request (the form is saved after the picture is sent): left alone this long. */
const UNATTACHED_GRACE_MS = 24 * 3600_000;
/** A picture found in use is checked again this much later (its entity may have been deleted since). */
const RECHECK_MS = 7 * 24 * 3600_000;
const SWEEP_BATCH = 200;

export class MediaService {
  private readonly media: Collection<MediaDoc>;
  private readonly usages: MediaUsage[] = [];

  constructor(
    private readonly db: Db,
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

  /** Each module that keeps pictures says where: a picture referenced in none of these places can be deleted. */
  trackUsage(usages: MediaUsage[]) {
    this.usages.push(...usages);
  }

  private async inUse(id: ObjectId) {
    for (const u of this.usages) if (await this.db.collection(u.collection).findOne({ [u.path]: id }, { projection: { _id: 1 } })) return true;
    return false;
  }

  /**
   * After an entity dropped pictures (replaced, removed, entity deleted), once that change is saved: each one that
   * nothing else references (a banner may reuse its event's picture) is deleted from the storage, then forgotten.
   * Never throws: what fails here is retried by the sweep.
   */
  async release(ids: (ObjectId | null | undefined)[]): Promise<number> {
    const unique = [...new Map(ids.filter((x): x is ObjectId => !!x).map((id) => [id.toHexString(), id])).values()];
    let deleted = 0;
    for (const id of unique) deleted += await this.remove(id).catch(() => 0);
    return deleted;
  }

  private async remove(id: ObjectId): Promise<number> {
    if (await this.inUse(id)) return 0;
    const doc = await this.media.findOne({ _id: id });
    if (!doc) return 0;
    await this.storage.delete(doc.key);
    await this.media.deleteOne({ _id: id });
    return 1;
  }

  /**
   * Worker, hourly: uploads never attached (after a day) and pictures left behind by something that didn't release
   * them (an entity deleted). The ones still in use are marked and looked at again a week later.
   */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const due = await this.media
      .find(
        { createdAt: { $lte: new Date(now.getTime() - UNATTACHED_GRACE_MS) }, $or: [{ checkedAt: { $exists: false } }, { checkedAt: { $lte: new Date(now.getTime() - RECHECK_MS) } }] },
        { projection: { _id: 1 } },
      )
      .sort({ checkedAt: 1, createdAt: 1 })
      .limit(SWEEP_BATCH)
      .toArray();
    let deleted = 0;
    for (const { _id } of due) {
      if (await this.inUse(_id)) await this.media.updateOne({ _id }, { $set: { checkedAt: now } });
      else deleted += await this.remove(_id).catch(() => 0); // the storage failed: next sweep
    }
    return deleted;
  }
}
