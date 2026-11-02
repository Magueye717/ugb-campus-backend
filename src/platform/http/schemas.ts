import { ObjectId } from 'mongodb';
import { Type } from 'typebox';

import { errors } from './errors.js';

export const ObjectIdString = Type.String({ pattern: '^[a-f0-9]{24}$' });

export const IdParams = Type.Object({ id: ObjectIdString }, { additionalProperties: false });

/** Path ids are validated by schema; this turns them into ObjectIds (and 404s anything malformed that slipped through). */
export function toObjectId(id: string): ObjectId {
  if (!ObjectId.isValid(id) || !/^[a-f0-9]{24}$/.test(id)) throw errors.notFound();
  return new ObjectId(id);
}

export const Problem = Type.Object(
  { type: Type.String(), title: Type.String(), status: Type.Number(), code: Type.String(), message: Type.String(), requestId: Type.String() },
  { additionalProperties: true },
);

/** Senegalese mobile, as typed in the app (spaces allowed, with or without +221). Normalized by the service. */
export const PhoneInput = Type.String({ minLength: 9, maxLength: 20, pattern: '^[+0-9 ]+$' });
