import type { ObjectId } from 'mongodb';

/** What an image is for: decides its size limit and who may attach it. */
export const MEDIA_PURPOSES = ['banner', 'event', 'lost', 'business', 'place'] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

/**
 * An uploaded picture, after the server checked and re-encoded it (WebP, at most 1600 px, no metadata). Only the
 * uploader can attach it to their banner or event; clients never send URLs.
 */
export type MediaDoc = {
  _id: ObjectId;
  ownerId: ObjectId;
  purpose: MediaPurpose;
  /** Storage key: "banner/2026/11/<id>.webp". */
  key: string;
  url: string;
  contentType: 'image/webp';
  width: number;
  height: number;
  bytes: number;
  createdAt: Date;
};
