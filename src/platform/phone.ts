/** Senegalese mobile numbers, as the app validates them: 9 digits starting with 70/71/75/76/77/78. */
const LOCAL_RE = /^(70|71|75|76|77|78)\d{7}$/;

/** "77 123 45 67", "+221771234567", "00221 77…" → "+221771234567"; null when it isn't a Senegalese mobile. */
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('00221')) digits = digits.slice(5);
  else if (digits.startsWith('221') && digits.length === 12) digits = digits.slice(3);
  return LOCAL_RE.test(digits) ? `+221${digits}` : null;
}

/** "+221771234567" → "77 ••• •• 67": shown to other people and written to logs. */
export function maskPhone(e164: string): string {
  const d = e164.replace(/^\+221/, '');
  return `${d.slice(0, 2)} ••• •• ${d.slice(7, 9)}`;
}
