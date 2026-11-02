// Pragmatic check (one @, a dot in the domain, no spaces); real proof of ownership comes from a verification e-mail.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

/** " Awa.Diop@UGB.edu.sn " → "awa.diop@ugb.edu.sn"; null when it doesn't look like an address. */
export function normalizeEmail(input: string): string | null {
  const v = input.trim().toLowerCase();
  return v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

/** "awa.diop@ugb.edu.sn" → "aw•••p@ugb.edu.sn" (same masking as the app's maskEmail). */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 2)}•••${user.slice(-1)}@${domain}`;
}
