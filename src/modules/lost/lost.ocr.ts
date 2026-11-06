import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';

/** Reads the text of a card photo. Tesseract in the app, a fake in tests. */
export interface CardReader {
  read(image: Buffer): Promise<string>;
  close(): Promise<void>;
}

/**
 * Tesseract (French), in the API process: one worker, started on the first scan, reading one card at a time. The
 * photo is cleaned up first (upright, grey, contrast, 1600 px) and never stored. The language data is downloaded
 * once into `cacheDir`.
 */
export class TesseractCardReader implements CardReader {
  private worker: Promise<Worker> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cacheDir: string) {}

  read(image: Buffer): Promise<string> {
    const job = this.queue.then(async () => {
      const clean = await sharp(image).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).grayscale().normalize().sharpen().png().toBuffer();
      this.worker ??= createWorker('fra', 1, { cachePath: this.cacheDir });
      const { data } = await (await this.worker).recognize(clean);
      return data.text;
    });
    // A failed read doesn't block the next ones.
    this.queue = job.catch(() => undefined);
    return job;
  }

  async close() {
    if (this.worker) await (await this.worker).terminate();
    this.worker = null;
  }
}

/** What was found: decides how the names are read, and what the owner is told. */
export const CARD_TYPES = ['student', 'national_id', 'driving_licence', 'bank'] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Letters OCR often reads instead of digits in a student number. */
const AS_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', Z: '2', S: '5', G: '6', B: '8' };

/** Words printed on cards: never a name. */
const NOT_NAMES = new Set([
  // Student card
  'UNIVERSITE', 'GASTON', 'BERGER', 'SAINT', 'LOUIS', 'CARTE', 'ETUDIANT', 'ETUDIANTE', 'ETUDIANTS', 'NOM', 'NOMS', 'PRENOM', 'PRENOMS', 'UFR', 'NE', 'NEE', 'LE', 'LA', 'LES', 'DE', 'DU',
  'DES', 'ET', 'ANNEE', 'ANNEES', 'UNIVERSITAIRE', 'NUMERO', 'SENEGAL', 'REPUBLIQUE', 'VALABLE', 'JUSQU', 'SIGNATURE', 'RECTEUR', 'FILIERE', 'NIVEAU', 'LICENCE', 'MASTER', 'INSCRIPTION',
  'SAT', 'LSH', 'SJP', 'SEG', 'CRAC', 'SEFS', 'SANTE', 'SCIENCES', 'APPLIQUEES', 'TECHNOLOGIE', 'LETTRES', 'HUMAINES', 'JURIDIQUES', 'POLITIQUES', 'ECONOMIQUES', 'GESTION',
  // Identity card, driving licence
  'IDENTITE', 'IDENTITY', 'NATIONALE', 'NATIONAL', 'CEDEAO', 'ECOWAS', 'CARD', 'SURNAME', 'GIVEN', 'NAMES', 'NAME', 'SEXE', 'SEX', 'TAILLE', 'HEIGHT', 'DATE', 'NAISSANCE', 'BIRTH',
  'LIEU', 'PLACE', 'ADRESSE', 'ADDRESS', 'DELIVRANCE', 'ISSUE', 'EXPIRATION', 'EXPIRY', 'PERMIS', 'CONDUIRE', 'DRIVING', 'LICENSE', 'CATEGORIES', 'NIN', 'USAGE', 'UN', 'PEUPLE', 'BUT', 'FOI',
  // Bank card
  'VISA', 'MASTERCARD', 'MAESTRO', 'DEBIT', 'CREDIT', 'VALID', 'THRU', 'VALIDE', 'FIN', 'MONTH', 'YEAR', 'BANK', 'BANQUE', 'ECOBANK', 'CBAO', 'UBA', 'SGBS', 'BICIS', 'BHS', 'BIS', 'ORABANK',
  'CORIS', 'GIM', 'UEMOA', 'PREPAID', 'PREPAYEE', 'CLASSIC', 'GOLD', 'PLATINUM', 'ELECTRON', 'MEMBER', 'SINCE', 'WAVE', 'ORANGE', 'MONEY', 'ATTIJARI', 'SOCIETE', 'GENERALE', 'INTERNATIONAL',
]);

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const nameWords = (s: string) => (s.match(/[A-Za-zÀ-ÖØ-öø-ÿ'-]{2,}/g) ?? []).filter((w) => !NOT_NAMES.has(fold(w).replace(/['-]/g, '')));

/** Which card: the words printed on it. */
export function cardTypeOf(text: string, studentNumber: string | null): CardType | null {
  const f = fold(text);
  if (/UNIVERSIT|ETUDIANT|GASTON\s*BERGER/.test(f) || studentNumber) return 'student';
  if (/PERMIS\s*DE\s*CONDUIRE|DRIVING\s*LICEN/.test(f)) return 'driving_licence';
  if (/IDENTITE|IDENTITY|CEDEAO|ECOWAS|CARTE\s*NATIONALE/.test(f)) return 'national_id';
  if (/VISA|MASTERCARD|MAESTRO|VALID\s*THRU|VALIDE\s*(JUSQU|FIN)|DEBIT|BANQUE|BANK|\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/.test(f)) return 'bank';
  return null;
}

/**
 * Names behind labels ("Nom :", "Prénoms / Given names"): on the same line, or on the next one (identity cards
 * print the value under its label). Driving licences number their fields: "1. NDIAYE", "2. FATOU".
 */
function labelledNames(lines: string[]) {
  const out: string[] = [];
  const valueAfter = (i: number, rest: string) => {
    const same = nameWords(rest);
    if (same.length) return same;
    const next = lines[i + 1];
    return next && !/[:]/.test(next) ? nameWords(next) : [];
  };
  lines.forEach((line, i) => {
    const f = fold(line);
    const numbered = f.match(/^\s*[12]\s*[.)]\s*(.+)$/);
    if (numbered) return void out.push(...nameWords(line.slice(line.length - numbered[1]!.length)));
    const label = f.match(/\b(PRENOMS?|GIVEN\s*NAMES?|NOMS?|SURNAME)\b\s*(?:\(S\))?\s*[:.]?\s*(.*)$/);
    if (!label) return;
    // "Nom / Surname": what follows the slash is the label in English (even misread), the value is on the next line.
    const rest = label[2]!.startsWith('/') ? '' : line.slice(line.length - label[2]!.length);
    out.push(...valueAfter(i, rest));
  });
  return out;
}

/** Bank cards: the holder's name in capitals at the bottom, under the card number. */
function embossedName(lines: string[]) {
  for (const line of [...lines].reverse()) {
    const f = fold(line).trim();
    if (!/^[A-Z][A-Z' .-]{3,}$/.test(f)) continue;
    const words = nameWords(line);
    if (words.length >= 2 && words.length <= 4) return words;
  }
  return [];
}

/**
 * What a card's text tells: its type, its student number (P232055) and the holder's names. Student, identity cards
 * and licences have labelled lines; a bank card only has the name embossed at the bottom. Without either, the
 * words left are candidates (the search ranks them).
 */
export function parseCard(text: string): { cardType: CardType | null; studentNumber: string | null; names: string[] } {
  const upper = fold(text);
  // "P 232 055", "P232O55", "N° : P232055": a P then 6 to 11 digits, spaces and look-alike letters forgiven.
  let studentNumber: string | null = null;
  for (const m of upper.replace(/[ \t.]/g, '').matchAll(/P([0-9OQDILZSGB|]{6,11})(?![0-9])/g)) {
    const digits = [...m[1]!].map((c) => AS_DIGIT[c] ?? c).join('');
    if (/^\d{6,11}$/.test(digits)) {
      studentNumber = `P${digits}`;
      break;
    }
  }
  const cardType = cardTypeOf(text, studentNumber);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // No card recognized (an empty table, a wall, a blur): no names either, nothing to search.
  if (!cardType) return { cardType: null, studentNumber: null, names: [] };
  let names = cardType === 'bank' ? embossedName(lines) : labelledNames(lines);
  if (!names.length) names = lines.flatMap((l) => (/\d/.test(l) ? [] : nameWords(l)));
  return { cardType, studentNumber: cardType === 'student' ? studentNumber : null, names: [...new Set(names)].slice(0, 6) };
}

/** The details a student card gives besides the name, to complete the profile. */
export type CardIdentity = { birthDate: string | null; birthPlace: string | null; nationality: string | null };

const KNOWN_NATIONALITIES: Record<string, string> = {
  SENEGALAISE: 'Sénégalaise', SENEGALAIS: 'Sénégalais', GUINEENNE: 'Guinéenne', GUINEEN: 'Guinéen', MALIENNE: 'Malienne', MALIEN: 'Malien', GAMBIENNE: 'Gambienne', GAMBIEN: 'Gambien',
  MAURITANIENNE: 'Mauritanienne', MAURITANIEN: 'Mauritanien', IVOIRIENNE: 'Ivoirienne', IVOIRIEN: 'Ivoirien', BURKINABE: 'Burkinabè', CAPVERDIENNE: 'Cap-verdienne', CAPVERDIEN: 'Cap-verdien',
};
/** "SAINT-LOUIS" → "Saint-Louis". */
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());

/** A month written in letters (French or English, whole or cut short): its number. "JUIN" and "JUILLET" told apart. */
const MONTHS: [RegExp, number][] = [
  [/^JANV?|^JAN/, 1], [/^FEV|^FEB/, 2], [/^MARS?$|^MAR(CH)?/, 3], [/^AVR|^APR/, 4], [/^MAI$|^MAY$/, 5], [/^JUIN|^JUNE?$/, 6],
  [/^JUIL|^JUL/, 7], [/^AOU|^AUG/, 8], [/^SEP/, 9], [/^OCT/, 10], [/^NOV/, 11], [/^DEC/, 12],
];
const monthOf = (word: string) => MONTHS.find(([re]) => re.test(word))?.[1];
// The labels a card uses (French and English), to find what follows them, and never take one for a value.
const BIRTH_DATE = /DATE\s*(?:ET\s*LIEU\s*)?DE\s*NAISS|DATE\s*NAISS|\bD\.?\s*NAISS|\bNEE?\s*(?:\(E\))?\s*LE\b|DATE\s*OF\s*BIRTH|\bBORN\b/;
// Not « Date et lieu de naissance » (the date's label: its place comes after the date, « à … »).
const BIRTH_PLACE = /(?<!ET\s*)LIEU\s*DE\s*NAISS|(?<!ET\s*)LIEU\s*NAISS|PLACE\s*OF\s*BIRTH/;
const NATIONALITY = /NATIONALITE|NATIONALITY/;
const ANY_LABEL = /NAISS|BIRTH|NATIONALIT|\bNOMS?\b|PRENOM|\bSEXE\b|\bUFR\b|FILIERE|NIVEAU|MATRICULE|\bN\s*°|ADRESSE|VALIDIT|EXPIR|ANNEE/;

/** A day in a line of OCR: "12/03/2002", "12.03.2002", "12 03 2002", "12 mars 2002", "12032002" ("O"/"l" read for 0/1). */
function datesIn(raw: string): { y: number; mo: number; d: number }[] {
  // Letters read for digits, only where digits are around.
  const s = fold(raw).replace(/[0-9OQIL|]{2,}/g, (tok) => (/\d/.test(tok) ? tok.replace(/[OQ]/g, '0').replace(/[IL|]/g, '1') : tok));
  const out: { y: number; mo: number; d: number }[] = [];
  for (const m of s.matchAll(/(\d{1,2})\s*[/.\- ]\s*(\d{1,2})\s*[/.\- ]\s*(\d{4})/g)) out.push({ d: Number(m[1]), mo: Number(m[2]), y: Number(m[3]) });
  // In letters: "14 janvier 1993", "1er sept. 2001", "14 JANVIER 1993".
  for (const m of s.matchAll(/(\d{1,2})\s*(?:ER)?\s+([A-Z]{3,9})\.?\s+(\d{4})/g)) {
    const mo = monthOf(m[2]!);
    if (mo) out.push({ d: Number(m[1]), mo, y: Number(m[3]) });
  }
  for (const m of s.matchAll(/(?<!\d)(\d{2})(\d{2})(\d{4})(?!\d)/g)) out.push({ d: Number(m[1]), mo: Number(m[2]), y: Number(m[3]) });
  return out;
}

/**
 * Birth date, place of birth and nationality, behind their labels ("Date de naissance", "Date et lieu de naissance",
 * "Né(e) le … à …", "Lieu de naissance", "Nationalité"), on the same line or the next ones. OCR often reads a card in
 * blocks (all the labels, then all the values): a label is never taken for a value, and a birth date not found by its
 * label is the card's date that fits a student's age (the oldest: the others are issue or validity dates).
 * Dates come back as YYYY-MM-DD.
 */
export function parseIdentity(text: string, now = new Date()): CardIdentity {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const isLabel = (l: string) => ANY_LABEL.test(fold(l)) && !/\d/.test(l);
  /** What follows the label: the rest of its line, or the next line that isn't another label. */
  const after = (re: RegExp) => {
    for (let i = 0; i < lines.length; i++) {
      const m = fold(lines[i]!).match(re);
      if (!m) continue;
      const rest = lines[i]!.slice(m.index! + m[0].length).replace(/^[\p{L}]*[\s:./()-]*/u, '').replace(/^[\s:./-]+/, '').trim();
      if (rest && !isLabel(rest)) return rest;
      const next = lines[i + 1];
      return next && !isLabel(next) ? next : null;
    }
    return null;
  };
  const plausible = (x: { y: number; mo: number; d: number }) => {
    const age = now.getFullYear() - x.y;
    return x.mo >= 1 && x.mo <= 12 && x.d >= 1 && x.d <= 31 && age >= 14 && age <= 80;
  };
  const iso = (x: { y: number; mo: number; d: number }) => `${x.y}-${String(x.mo).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`;
  const toDate = (s: string | null) => {
    const x = s ? datesIn(s).find(plausible) : undefined;
    return x ? iso(x) : null;
  };
  const labelled = after(BIRTH_DATE);
  const oldest = datesIn(text)
    .filter(plausible)
    .sort((a, b) => a.y - b.y || a.mo - b.mo || a.d - b.d)[0];
  const birthDate = toDate(labelled) ?? (oldest ? iso(oldest) : null);
  // "Né(e) le 12/03/2002 à Saint-Louis", "Date et lieu de naissance : 12/03/2002 à Dakar": the place after the date.
  const bornAt = labelled?.match(/\d{4}\s*(?:A|À|a|à)\s+(.+)$/)?.[1] ?? null;
  const placeRaw = after(BIRTH_PLACE) ?? bornAt;
  const place = placeRaw?.replace(/[^\p{L}' -]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:à|a)\s+/i, '') ?? '';
  const natRaw = after(NATIONALITY);
  const nat = natRaw?.match(/\p{L}[\p{L}-]{2,}/u)?.[0] ?? null;
  return {
    birthDate,
    birthPlace: place.length >= 2 && !isLabel(place) ? titleCase(place).slice(0, 60) : null,
    nationality: nat && !isLabel(nat) ? (KNOWN_NATIONALITIES[fold(nat).replace(/-/g, '')] ?? titleCase(nat)) : null,
  };
}
