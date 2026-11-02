import { ObjectId, type Collection, type Db } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import { CAMPUS_LABELS, type Campus } from '../accounts/index.js';
import type { MediaApi } from '../media/index.js';
import type { PlaceCategory, PlaceDoc } from './places.types.js';

export type PlaceInput = {
  name: string;
  category: PlaceCategory;
  description?: string;
  area?: string;
  campus?: Campus | null;
  location: { lat: number; lng: number };
  hours?: string | null;
  icon?: string;
  /**
   * The pictures, in order (the first is the cover): an uploaded picture's id (POST /media/images?purpose=place), or
   * the url of one the place already has (`photoRefs` in the view).
   */
  photos?: string[];
  active?: boolean;
  sortOrder?: number;
};

/** Default icon per category, when none is chosen. */
const ICONS: Record<PlaceCategory, string> = {
  Études: 'book-outline', Restauration: 'restaurant-outline', Services: 'storefront-outline', Sport: 'football-outline', Santé: 'medkit-outline',
  Administration: 'business-outline', Logement: 'bed-outline', Culte: 'moon-outline', Transport: 'bus-outline',
};

export class PlacesService {
  private readonly places: Collection<PlaceDoc>;

  constructor(
    db: Db,
    private readonly clock: Clock,
    private readonly media: MediaApi,
  ) {
    this.places = db.collection('places');
  }

  /** What students see: active places, in the team's order. Admins also get the hidden ones. */
  list(all = false) {
    return this.places.find(all ? {} : { active: true }).sort({ sortOrder: 1, name: 1 }).toArray();
  }

  async get(id: ObjectId, all = false) {
    const p = await this.places.findOne({ _id: id, ...(all ? {} : { active: true }) });
    if (!p) throw errors.notFound('Lieu introuvable.');
    return p;
  }

  private async photos(by: ObjectId, refs: string[], keep: PlaceDoc['photos']) {
    // Pictures the place has stay as they are (seeded ones have no media id); new uploads are claimed.
    const has = (ref: string) => keep.find((p) => p.mediaId?.toHexString() === ref || p.url === ref);
    const fresh = refs.filter((r) => !has(r));
    if (fresh.some((r) => !ObjectId.isValid(r))) throw errors.validation('Photo inconnue.', { field: 'photos' });
    const claimed = fresh.length ? await this.media.claim(by, fresh) : [];
    return refs.map((r) => has(r) ?? { url: claimed.find((c) => c.mediaId.toHexString() === r)!.url, mediaId: new ObjectId(r) });
  }

  async create(by: ObjectId, input: PlaceInput) {
    const now = this.clock.now();
    const doc: PlaceDoc = {
      _id: new ObjectId(), name: input.name.trim(), category: input.category, description: input.description?.trim() ?? '', area: input.area?.trim() ?? '', campus: input.campus ?? null,
      location: input.location, hours: input.hours?.trim() || null, icon: input.icon ?? ICONS[input.category], photos: input.photos ? await this.photos(by, input.photos, []) : [],
      active: input.active ?? true, sortOrder: input.sortOrder ?? now.getTime(), createdAt: now, updatedAt: now,
    };
    await this.places.insertOne(doc);
    return doc;
  }

  async update(by: ObjectId, id: ObjectId, input: Partial<PlaceInput>) {
    const p = await this.get(id, true);
    const set: Partial<PlaceDoc> = { updatedAt: this.clock.now() };
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.category !== undefined) set.category = input.category;
    if (input.description !== undefined) set.description = input.description.trim();
    if (input.area !== undefined) set.area = input.area.trim();
    if (input.campus !== undefined) set.campus = input.campus;
    if (input.location !== undefined) set.location = input.location;
    if (input.hours !== undefined) set.hours = input.hours?.trim() || null;
    if (input.icon !== undefined) set.icon = input.icon;
    if (input.photos !== undefined) set.photos = await this.photos(by, input.photos, p.photos);
    if (input.active !== undefined) set.active = input.active;
    if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
    await this.places.updateOne({ _id: id }, { $set: set });
    return this.get(id, true);
  }

  async remove(id: ObjectId) {
    const res = await this.places.deleteOne({ _id: id });
    if (!res.deletedCount) throw errors.notFound('Lieu introuvable.');
  }

  view(p: PlaceDoc) {
    return {
      id: p._id.toHexString(), name: p.name, category: p.category, description: p.description, area: p.area, campus: p.campus, campusLabel: p.campus ? CAMPUS_LABELS[p.campus] : null,
      location: p.location, hours: p.hours, icon: p.icon, photos: p.photos.map((x) => x.url),
      // Editing: send them back as `photos` to keep them (an upload's id, or the url of a seeded picture).
      photoRefs: p.photos.map((x) => x.mediaId?.toHexString() ?? x.url), active: p.active, sortOrder: p.sortOrder,
    };
  }

  /** Seed: the first places, with their external pictures. Skipped when a place of that name exists. */
  /** Seed only: removes the places of an older seed, by name. */
  async retire(names: string[]) {
    return (await this.places.deleteMany({ name: { $in: names } })).deletedCount;
  }

  async seed(list: (Omit<PlaceInput, 'photos'> & { photoUrls?: string[] })[]) {
    const existing = new Set((await this.list(true)).map((p) => p.name));
    let added = 0;
    for (const [i, input] of list.entries()) {
      if (existing.has(input.name)) continue;
      const now = this.clock.now();
      await this.places.insertOne({
        _id: new ObjectId(), name: input.name, category: input.category, description: input.description ?? '', area: input.area ?? '', campus: input.campus ?? null, location: input.location,
        hours: input.hours ?? null, icon: input.icon ?? ICONS[input.category], photos: (input.photoUrls ?? []).map((url) => ({ url, mediaId: null })), active: true, sortOrder: i, createdAt: now, updatedAt: now,
      });
      added++;
    }
    return added;
  }
}
