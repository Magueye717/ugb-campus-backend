import type { ObjectId } from 'mongodb';

/**
 * A picture stored by the media module (profile picture, organization logo…).
 * Only the media module creates these after validating and re-encoding the upload: clients never send URLs.
 */
export type ImageRef = { mediaId: ObjectId; url: string };
