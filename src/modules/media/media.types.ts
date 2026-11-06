import type { ObjectId } from 'mongodb';

/** What an image is for: decides its size limit and who may attach it. */
export const MEDIA_PURPOSES = ['banner', 'event', 'lost', 'business', 'place', 'avatar', 'alert'] as const;
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
  /** Pictures are re-encoded to WebP; documents (an announcement's PDF) are kept as sent, once checked. */
  contentType: 'image/webp' | 'application/pdf';
  /** Pictures only. */
  width?: number;
  height?: number;
  /** Documents: the file name shown to students ("Calendrier des examens.pdf"). */
  name?: string;
  /** Documents: how many pages, when the PDF says so (read on upload). */
  pages?: number;
  bytes: number;
  createdAt: Date;
  /** Last time the hourly sweep found it still attached somewhere: it is checked again a week later. */
  checkedAt?: Date;
};

/** A document attached to something (an announcement): where it is, its name and size for the download button. */
export type FileRef = { mediaId: ObjectId; url: string; name: string; bytes: number; pages?: number | null };

/** Where other modules keep picture references: a collection and the path of the `mediaId` (arrays included). */
export type MediaUsage = { collection: string; path: string };
