import argon2 from 'argon2';

// OWASP baseline for Argon2id; tune memoryCost/timeCost to ~100 ms on the production CPU.
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => argon2.hash(password, OPTIONS);

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export const needsRehash = (hash: string) => argon2.needsRehash(hash, OPTIONS);

/** Same rules as the app (≥ 8 characters, ≥ 1 digit), plus a ceiling and a few obvious passwords. */
const COMMON = new Set(['password1', 'motdepasse1', '12345678', '123456789', 'azerty123', 'qwerty123', 'senegal1', 'password123']);
export function passwordProblem(p: string): string | null {
  if (p.length < 8 || !/\d/.test(p)) return 'Au moins 8 caractères, dont 1 chiffre.';
  if (p.length > 128) return 'Mot de passe trop long.';
  if (COMMON.has(p.toLowerCase())) return 'Ce mot de passe est trop courant.';
  return null;
}
