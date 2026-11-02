import type { ClientSession, ObjectId } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import { normalizeEmail } from '../../platform/email.js';
import { normalizePhone, maskPhone } from '../../platform/phone.js';
import type { AccountsRepository } from './accounts.repository.js';
import {
  NAME_RE, REGIONS, ROLE_SPACES, ROOM_RE, STUDENT_NUMBER_RE, UFR_CODES, VILLAGES,
  type AppSpace, type Audience, type AudienceProfile, type Campus, type MembershipSummary, type Region, type UfrCode, type NewStudentAccount, type NotificationPrefs, type OrganizationsPort, type PlatformRole, type StudentProfileDoc, type UserDoc,
} from './accounts.types.js';

/** Progressive lock after repeated wrong passwords: 5th failure → 1 min, then 5, 15, 60 min. */
const LOCK_STEPS_MIN = [1, 5, 15, 60];
const LOCK_AFTER = 5;

const DEFAULT_PREFS: NotificationPrefs = { social: true, cours: true, paiements: true, campus: true };

export type StudentProfileInput = { campus: Campus; onCampus: boolean; village?: string | null; room?: string | null };

export class AccountsService {
  constructor(
    private readonly repo: AccountsRepository,
    private readonly clock: Clock,
    private readonly organizations: () => OrganizationsPort,
  ) {}

  // ---- Validation shared by sign-up and profile edits -------------------------------------------------

  normalizeStudentNumber(input: string) {
    const v = input.toUpperCase().replace(/\s/g, '');
    if (!STUDENT_NUMBER_RE.test(v)) throw errors.validation('Numéro étudiant invalide. Exemple : P232055', { field: 'studentNumber' });
    return v;
  }

  normalizeName(input: string, field: 'firstName' | 'lastName') {
    const v = input.trim().replace(/\s+/g, ' ');
    if (!v || v.length > 60 || !NAME_RE.test(v)) throw errors.validation('Utilise uniquement des lettres, des espaces ou des tirets.', { field });
    return v;
  }

  /** Village and room only for students living in a campus residence; the village must belong to the campus. */
  residence(input: StudentProfileInput): { onCampus: boolean; village: string | null; room: string | null } {
    if (!input.onCampus) return { onCampus: false, village: null, room: null };
    const village = input.village ?? '';
    if (!VILLAGES[input.campus].includes(village)) throw errors.validation('Choisis ton village.', { field: 'village' });
    const room = (input.room ?? '').toUpperCase().replace(/\s/g, '');
    if (!ROOM_RE.test(room)) throw errors.validation('Numéro de chambre invalide. Exemple : 214 ou C12', { field: 'room' });
    return { onCampus: true, village, room };
  }

  /** UFR and home region, as asked at sign-up and in the profile. */
  origin(input: { ufr: string; region: string }): { ufr: UfrCode; region: Region } {
    if (!(UFR_CODES as string[]).includes(input.ufr)) throw errors.validation('Choisis ton UFR.', { field: 'ufr' });
    if (!(REGIONS as readonly string[]).includes(input.region)) throw errors.validation('Choisis ta région d’origine.', { field: 'region' });
    return { ufr: input.ufr as UfrCode, region: input.region as Region };
  }

  phoneOrThrow(input: string) {
    const phone = normalizePhone(input);
    if (!phone) throw errors.validation('Numéro invalide. Il doit commencer par 70, 71, 75, 76, 77 ou 78.', { field: 'phone' });
    return phone;
  }

  // ---- Sign-up -----------------------------------------------------------------------------------------

  async availability(phone: string, studentNumber: string) {
    const [phoneTaken, numberTaken] = await Promise.all([this.repo.phoneExists(phone), this.repo.studentNumberExists(studentNumber)]);
    return { available: !phoneTaken && !numberTaken, conflict: phoneTaken ? ('phone' as const) : numberTaken ? ('student_number' as const) : undefined };
  }

  /** User + student profile, inside the caller's transaction. Unique indexes decide races between two sign-ups. */
  async createStudentAccount(input: NewStudentAccount, session: ClientSession): Promise<UserDoc> {
    const now = this.clock.now();
    const user: UserDoc = {
      _id: this.repo.newId(),
      phone: input.phone,
      phoneVerifiedAt: now,
      passwordHash: input.passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      status: 'active',
      platformRoles: [],
      login: { failedCount: 0, lockedUntil: null, lastLoginAt: null },
      terms: { version: input.termsVersion, acceptedAt: now },
      notificationPrefs: DEFAULT_PREFS,
      payoutAccount: { phone: input.phone, verifiedAt: now },
      email: null,
      avatar: null,
      lastLocation: null,
      createdAt: now,
      updatedAt: now,
    };
    const profile: StudentProfileDoc = {
      _id: this.repo.newId(),
      userId: user._id,
      studentNumber: input.studentNumber,
      campus: input.campus,
      onCampus: input.onCampus,
      village: input.village,
      room: input.room,
      ufr: input.ufr,
      region: input.region,
      filiere: null,
      niveau: null,
      academicGroupIds: [],
      verification: { status: 'unverified', verifiedAt: null },
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.repo.insertUser(user, session);
      await this.repo.insertProfile(profile, session);
    } catch (err) {
      if (isDuplicateKey(err, 'phone_unique')) throw errors.conflict('PHONE_TAKEN', 'Ce numéro a déjà un compte.');
      if (isDuplicateKey(err, 'student_number_unique')) throw errors.conflict('STUDENT_NUMBER_TAKEN', 'Ce numéro étudiant a déjà un compte.');
      throw err;
    }
    return user;
  }

  /** Accounts created by an admin (organizer staff): no student profile, no password until "mot de passe oublié". */
  async createStaffUser(input: { phone: string; firstName: string; lastName: string }): Promise<UserDoc> {
    const now = this.clock.now();
    const phone = this.phoneOrThrow(input.phone);
    const user: UserDoc = {
      _id: this.repo.newId(),
      phone,
      phoneVerifiedAt: null,
      passwordHash: null,
      firstName: this.normalizeName(input.firstName, 'firstName'),
      lastName: this.normalizeName(input.lastName, 'lastName'),
      status: 'active',
      platformRoles: [],
      login: { failedCount: 0, lockedUntil: null, lastLoginAt: null },
      terms: null,
      notificationPrefs: DEFAULT_PREFS,
      payoutAccount: { phone, verifiedAt: now },
      email: null,
      avatar: null,
      lastLocation: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.repo.insertUser(user);
    } catch (err) {
      if (isDuplicateKey(err, 'phone_unique')) throw errors.conflict('PHONE_TAKEN', 'Ce numéro a déjà un compte.');
      throw err;
    }
    return user;
  }

  // ---- Login support -----------------------------------------------------------------------------------

  /** Phone number or student number (the API accepts both; the app currently sends the phone). */
  async findForLogin(identifier: string): Promise<UserDoc | null> {
    const phone = normalizePhone(identifier);
    if (phone) return this.repo.findUserByPhone(phone);
    const number = identifier.toUpperCase().replace(/\s/g, '');
    if (!STUDENT_NUMBER_RE.test(number)) return null;
    const profile = await this.repo.findProfileByStudentNumber(number);
    return profile ? this.repo.findUserById(profile.userId) : null;
  }

  findByPhone(phone: string, session?: ClientSession) {
    return this.repo.findUserByPhone(phone, session);
  }

  findById(id: ObjectId) {
    return this.repo.findUserById(id);
  }

  /** What each user agreed to receive as push notifications (Social / Cours / Paiements switches). */
  async notificationPrefsByIds(ids: ObjectId[]): Promise<Map<string, NotificationPrefs>> {
    const users = ids.length ? await this.repo.findPrefsByIds(ids) : [];
    return new Map(users.map((u) => [u._id.toHexString(), u.notificationPrefs]));
  }

  /**
   * Names and phone numbers, for people who need to reach someone (an organizer calling a late passenger).
   * Callers must check that right themselves.
   */
  async contactsByIds(ids: ObjectId[]): Promise<Map<string, { firstName: string; lastName: string; phone: string }>> {
    const users = ids.length ? await this.repo.findContactsByIds(ids) : [];
    return new Map(users.map((u) => [u._id.toHexString(), { firstName: u.firstName, lastName: u.lastName, phone: u.phone }]));
  }

  /** First and last names of several users at once (lists that show who is in a trip). */
  async namesByIds(ids: ObjectId[]): Promise<Map<string, { firstName: string; lastName: string }>> {
    const users = ids.length ? await this.repo.findUsersByIds(ids) : [];
    return new Map(users.map((u) => [u._id.toHexString(), { firstName: u.firstName, lastName: u.lastName }]));
  }

  /** Returns the lock end when this failure triggers (or extends) a lock. */
  async recordLoginFailure(userId: ObjectId): Promise<Date | null> {
    const now = this.clock.now();
    const count = await this.repo.incrementLoginFailures(userId, now);
    if (count < LOCK_AFTER) return null;
    const minutes = LOCK_STEPS_MIN[Math.min(count - LOCK_AFTER, LOCK_STEPS_MIN.length - 1)]!;
    const until = new Date(now.getTime() + minutes * 60_000);
    await this.repo.setLockedUntil(userId, until);
    return until;
  }

  recordLoginSuccess(userId: ObjectId) {
    return this.repo.recordLoginSuccess(userId, this.clock.now());
  }

  setPassword(userId: ObjectId, passwordHash: string, session?: ClientSession) {
    return this.repo.setPassword(userId, passwordHash, this.clock.now(), session);
  }

  // ---- Profile -----------------------------------------------------------------------------------------

  async getMe(userId: ObjectId) {
    const user = await this.repo.findUserById(userId);
    if (!user) throw errors.unauthenticated();
    const [profile, memberships] = await Promise.all([this.repo.findProfileByUserId(userId), this.organizations().membershipsForUser(userId)]);
    // In this order: the first one is where the app opens (a student stays a student, whatever their roles).
    const spaces: AppSpace[] = [];
    if (profile) spaces.push('student');
    // A restaurant or shop has its own space (orders, catalog); other organizations the organizer one.
    const isBusiness = (m: MembershipSummary) => m.capabilities.includes('restaurant') || m.capabilities.includes('shop');
    if (memberships.some((m) => !isBusiness(m))) spaces.push('organizer');
    if (memberships.some(isBusiness)) spaces.push('business');
    const admin = user.platformRoles.includes('admin');
    for (const r of ROLE_SPACES) if (admin || r.roles.some((role) => user.platformRoles.includes(role))) spaces.push(r.space);
    return {
      id: user._id.toHexString(),
      firstName: user.firstName,
      lastName: user.lastName,
      initials: `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase(),
      phoneMasked: maskPhone(user.phone),
      platformRoles: user.platformRoles,
      student: profile
        ? {
            studentNumber: profile.studentNumber,
            campus: profile.campus,
            onCampus: profile.onCampus,
            village: profile.village,
            room: profile.room,
            ufr: profile.ufr,
            region: profile.region,
            filiere: profile.filiere,
            niveau: profile.niveau,
            verified: profile.verification.status === 'verified',
            identity: profile.identity
              ? { birthDate: profile.identity.birthDate, birthPlace: profile.identity.birthPlace, nationality: profile.identity.nationality, fromCard: profile.identity.source === 'card', updatedAt: profile.identity.updatedAt.toISOString() }
              : null,
          }
        : null,
      spaces,
      organizations: memberships.map((m) => ({ id: m.orgId, name: m.name, category: m.category, level: m.level, roles: m.roles, capabilities: m.capabilities })),
      payoutPhoneMasked: maskPhone(user.payoutAccount.phone),
      email: user.email ? { address: user.email.address, verified: user.email.verifiedAt !== null } : null,
      avatarUrl: user.avatar?.url ?? null,
      // Only ever returned to the user themself.
      location: user.lastLocation
        ? {
            lat: user.lastLocation.point.coordinates[1],
            lng: user.lastLocation.point.coordinates[0],
            accuracyM: user.lastLocation.accuracyM,
            updatedAt: user.lastLocation.updatedAt.toISOString(),
          }
        : null,
    };
  }

  async updateResidence(userId: ObjectId, input: { onCampus: boolean; village?: string | null; room?: string | null }) {
    const profile = await this.repo.findProfileByUserId(userId);
    if (!profile) throw errors.forbidden('Réservé aux étudiants.');
    const residence = this.residence({ campus: profile.campus, ...input });
    await this.repo.updateProfile(userId, residence, this.clock.now());
  }

  /** "Mon UFR et ma région" in the profile (students who signed up before they were asked, or who changed UFR). */
  async updateOrigin(userId: ObjectId, input: { ufr: string; region: string }) {
    const profile = await this.repo.findProfileByUserId(userId);
    if (!profile) throw errors.forbidden('Réservé aux étudiants.');
    await this.repo.updateProfile(userId, this.origin(input), this.clock.now());
  }

  /** Birth date, place of birth, nationality: typed, or read from the student's own card and checked by them. */
  async updateIdentity(userId: ObjectId, input: { birthDate: string | null; birthPlace: string | null; nationality: string | null; fromCard?: boolean }) {
    const profile = await this.repo.findProfileByUserId(userId);
    if (!profile) throw errors.forbidden('Réservé aux étudiants.');
    const now = this.clock.now();
    if (input.birthDate) {
      const d = new Date(`${input.birthDate}T00:00:00Z`);
      const age = (now.getTime() - d.getTime()) / (365.25 * 24 * 3_600_000);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input.birthDate || age < 14 || age > 80) {
        throw errors.validation('Date de naissance invalide.', { field: 'birthDate' });
      }
    }
    const clean = (v: string | null) => v?.trim().replace(/\s+/g, ' ') || null;
    await this.repo.updateProfile(
      userId,
      { identity: { birthDate: input.birthDate, birthPlace: clean(input.birthPlace), nationality: clean(input.nationality), source: input.fromCard ? 'card' : 'manual', updatedAt: now } },
      now,
    );
  }

  /** What announcements are matched on for this account (null: not a student, whole-university items only). */
  async audienceOf(userId: ObjectId): Promise<AudienceProfile> {
    const p = await this.repo.findProfileByUserId(userId);
    return p ? { campus: p.campus, ufr: p.ufr, region: p.region, village: p.village } : null;
  }

  /** Students an announcement is for. A UFR- or region-targeted one skips students who haven't said theirs. */
  userIdsInAudience(a: Audience) {
    return this.repo.userIdsMatching({
      ...(a.campuses.length ? { campus: { $in: a.campuses } } : {}),
      ...(a.ufrs.length ? { ufr: { $in: a.ufrs } } : {}),
      ...(a.regions.length ? { region: { $in: a.regions } } : {}),
    });
  }

  /** The student holding this number (P232055), with what a found card needs: name, phone, UFR, campus. */
  async studentByNumber(studentNumber: string): Promise<StudentCard | null> {
    const p = await this.repo.findProfileByStudentNumber(studentNumber);
    if (!p) return null;
    const u = await this.repo.findUserById(p.userId);
    return u && u.status === 'active' ? cardOf(u, p) : null;
  }

  /**
   * Everyone whose first or last name contains one of these words (a card read by OCR, a name typed by the finder):
   * "ndiay" finds Ndiaye, "fatou" finds Fatoumata. Best matches first: a word that is a whole name counts twice, so
   * "NDIAYE Fatou" puts Fatou Ndiaye before the other Ndiayes. Accounts without a student profile are included
   * (an identity or bank card can be anyone's).
   */
  async searchStudents(words: string[], limit = 20): Promise<StudentCard[]> {
    const clean = [...new Set(words.map((w) => w.trim()).filter((w) => w.length >= 2))].slice(0, 6);
    if (!clean.length) return [];
    const users = await this.repo.findUsersByNames(clean.map(containing), 300);
    const profiles = new Map((await this.repo.findProfilesByUserIds(users.map((u) => u._id))).map((p) => [p.userId.toHexString(), p]));
    const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const wanted = clean.map(fold);
    return users
      .map((u) => {
        const names = `${u.firstName} ${u.lastName}`.split(/[\s'-]+/).map(fold);
        const score = wanted.reduce((n, w) => n + (names.includes(w) ? 2 : names.some((x) => x.includes(w)) ? 1 : 0), 0);
        return { card: cardOf(u, profiles.get(u._id.toHexString()) ?? null), score };
      })
      .sort((a, b) => b.score - a.score || a.card.lastName.localeCompare(b.card.lastName) || a.card.firstName.localeCompare(b.card.firstName))
      .slice(0, limit)
      .map((x) => x.card);
  }

  /** Adds or replaces the e-mail address. It starts unverified; a new address resets the verification. */
  async setEmail(userId: ObjectId, input: string) {
    const address = normalizeEmail(input);
    if (!address) throw errors.validation('Adresse e-mail invalide.', { field: 'email' });
    const user = await this.repo.findUserById(userId);
    if (!user) throw errors.unauthenticated();
    if (user.email?.address === address) return;
    const now = this.clock.now();
    try {
      await this.repo.setUserFields(userId, { email: { address, verifiedAt: null, addedAt: now } }, now);
    } catch (err) {
      if (isDuplicateKey(err, 'email_unique')) throw errors.conflict('EMAIL_TAKEN', 'Cette adresse e-mail est déjà utilisée par un autre compte.');
      throw err;
    }
  }

  removeEmail(userId: ObjectId) {
    return this.repo.setUserFields(userId, { email: null }, this.clock.now());
  }

  /** Stored as GeoJSON ([lng, lat]) so future "near me" queries can use the 2dsphere index. */
  setLocation(userId: ObjectId, input: { lat: number; lng: number; accuracyM?: number }) {
    const now = this.clock.now();
    return this.repo.setUserFields(
      userId,
      { lastLocation: { point: { type: 'Point', coordinates: [input.lng, input.lat] }, accuracyM: input.accuracyM ?? null, updatedAt: now } },
      now,
    );
  }

  clearLocation(userId: ObjectId) {
    return this.repo.setUserFields(userId, { lastLocation: null }, this.clock.now());
  }

  async getNotificationPrefs(userId: ObjectId) {
    const user = await this.repo.findUserById(userId);
    if (!user) throw errors.unauthenticated();
    return user.notificationPrefs;
  }

  setNotificationPrefs(userId: ObjectId, prefs: NotificationPrefs) {
    return this.repo.setNotificationPrefs(userId, prefs, this.clock.now());
  }

  async setPlatformRoles(userId: ObjectId, roles: PlatformRole[]) {
    const user = await this.repo.setPlatformRoles(userId, [...new Set(roles)], this.clock.now());
    if (!user) throw errors.notFound();
    return user;
  }

  // ---- Capability checks used by guards ------------------------------------------------------------------

  async hasStudentProfile(userId: ObjectId) {
    return (await this.repo.findProfileByUserId(userId)) !== null;
  }

  /** Read from the database, not the token: a revoked role stops working on the next request. */
  async hasPlatformRole(userId: ObjectId, role: PlatformRole) {
    const user = await this.repo.findUserById(userId);
    return !!user && user.status === 'active' && (user.platformRoles.includes(role) || user.platformRoles.includes('admin'));
  }
}

/** Someone a found card may belong to: enough to tell two namesakes apart, and to call them. Students have the rest. */
export type StudentCard = { userId: ObjectId; firstName: string; lastName: string; phone: string; studentNumber: string | null; ufr: UfrCode | null; campus: Campus | null; village: string | null };

const cardOf = (u: Pick<UserDoc, '_id' | 'firstName' | 'lastName' | 'phone'>, p: StudentProfileDoc | null): StudentCard => ({
  userId: u._id, firstName: u.firstName, lastName: u.lastName, phone: u.phone, studentNumber: p?.studentNumber ?? null, ufr: p?.ufr ?? null, campus: p?.campus ?? null, village: p?.village ?? null,
});

const ACCENTS: Record<string, string> = { a: 'aàâä', c: 'cç', e: 'eéèêë', i: 'iîï', o: 'oôö', u: 'uùûü', y: 'yÿ' };
/** A piece of a name, case and accents ignored: "ndiay" matches "NDIAYE", "ndeye" matches "Ndéye". */
function containing(word: string) {
  const plain = word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z'-]/g, '');
  return new RegExp([...plain].map((ch) => (ACCENTS[ch] ? `[${ACCENTS[ch]}]` : ch.replace(/[-']/g, '\\$&'))).join(''), 'i');
}
