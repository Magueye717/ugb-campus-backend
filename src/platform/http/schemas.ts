import { ObjectId } from 'mongodb';
import { Type, type Static, type TSchema } from 'typebox';

import { errors } from './errors.js';

export const ObjectIdString = Type.String({ pattern: '^[a-f0-9]{24}$' });

const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean']);

/**
 * `T` or null, safe with ajv's `coerceTypes`. In an `anyOf`, coercion rewrites the value in the first branch it tries:
 * null-first turns 0 and "" into null (free delivery became "no delivery"), value-first turns null into 0 or "". So a
 * primitive becomes `type: [t, 'null']` (coerced only when neither matches), an enum or a union of literals an `enum`
 * with null (no `type`: never coerced), and an object stays a union (nothing coerces into an object).
 */
export function Nullable<T extends TSchema>(t: T) {
  const s = t as unknown as Record<string, unknown>;
  if (typeof s.type === 'string' && PRIMITIVES.has(s.type)) return Type.Unsafe<Static<T> | null>({ ...s, type: [s.type, 'null'] });
  if (Array.isArray(s.enum)) return Type.Unsafe<Static<T> | null>({ ...s, enum: [...s.enum, null] });
  const branches = s.anyOf as Record<string, unknown>[] | undefined;
  if (branches?.length && branches.every((b) => 'const' in b)) {
    const { anyOf: _, ...rest } = s;
    return Type.Unsafe<Static<T> | null>({ ...rest, enum: [...branches.map((b) => b.const), null] });
  }
  return Type.Union([t, Type.Null()]);
}

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
