import type { Campus, PlatformRole, Region, UfrCode } from '../../src/modules/accounts/index.js';
import type { OrgCategory, OrgLevel, OrgRole } from '../../src/modules/organizations/index.js';

/** Development only. Documented in the README; never valid anywhere else. */
export const DEMO_PASSWORD = 'Campus2026';

type Membership = { org: string; roles: OrgRole[] };

// Same organizers as constants/data.ts (organizers).
export const organizations: { slug: string; name: string; category: OrgCategory; capabilities: ('caravans' | 'restaurant' | 'events')[]; level: OrgLevel; stats: { ratingAvg: number | null; ratingCount: number; tripsCount: number }; payoutPhone?: string; email?: string }[] = [
  { slug: 'khoule', name: 'Khoulé & Frère', category: 'Entreprise', capabilities: ['caravans'], level: 'confirme', stats: { ratingAvg: 4.2, ratingCount: 96, tripsCount: 128 }, payoutPhone: '770000001', email: 'contact@khoule-transport.sn' },
  { slug: 'globe', name: 'Globe One', category: 'Entreprise', capabilities: ['caravans'], level: 'confirme', stats: { ratingAvg: 4.0, ratingCount: 61, tripsCount: 86 } },
  // Verified for events too: Awa (its owner) can sell tickets and promote them with a banner.
  { slug: 'amicale-zig', name: 'Amicale de Ziguinchor', category: 'Amicale', capabilities: ['caravans', 'events'], level: 'verifie', stats: { ratingAvg: 4.7, ratingCount: 5, tripsCount: 5 }, payoutPhone: '770000002', email: 'amicale.ziguinchor@ugb.edu.sn' },
  { slug: 'ndar', name: 'GIE Ndar Transport', category: 'Transporteur', capabilities: ['caravans'], level: 'nouveau', stats: { ratingAvg: null, ratingCount: 0, tripsCount: 0 } },
];

// Phones match the app's demo accounts (demoAccounts) and the "Ce compte existe déjà" test account (features/register/auth.ts).
export const students: { phone: string; studentNumber: string; firstName: string; lastName: string; campus: Campus; village: string | null; room: string | null; ufr: UfrCode; region: Region; memberships?: Membership[]; platformRoles?: PlatformRole[] }[] = [
  { phone: '770000002', studentNumber: 'P232055', firstName: 'Awa', lastName: 'Diop', campus: 'campus1', village: 'Village E', room: '214', ufr: 'SAT', region: 'Saint-Louis', memberships: [{ org: 'amicale-zig', roles: ['owner'] }] },
  { phone: '771234567', studentNumber: 'P210001', firstName: 'Moussa', lastName: 'Sow', campus: 'campus1', village: 'Village E', room: '108', ufr: 'SJP', region: 'Dakar' },
  // A student who also works at the restaurants: student space first, "Restos publics" under "Mes espaces".
  { phone: '781112233', studentNumber: 'P220456', firstName: 'Fatou', lastName: 'Ndiaye', campus: 'campus2', village: 'Village H', room: 'C12', ufr: 'SEG', region: 'Ziguinchor', platformRoles: ['resto_u_staff'] },
  { phone: '761234500', studentNumber: 'P230789', firstName: 'Ibrahima', lastName: 'Diallo', campus: 'campus1', village: null, room: null, ufr: 'SAT', region: 'Kolda' },
];

export const staff: { phone: string; firstName: string; lastName: string; platformRoles?: PlatformRole[]; memberships?: Membership[] }[] = [
  { phone: '770000001', firstName: 'Modou', lastName: 'Khoulé', memberships: [{ org: 'khoule', roles: ['owner'] }] },
  { phone: '770000003', firstName: 'Cheikh', lastName: 'Fall', memberships: [{ org: 'khoule', roles: ['scanner'] }] },
  { phone: '770000099', firstName: 'Admin', lastName: 'Campus', platformRoles: ['admin'] },
  { phone: '770000004', firstName: 'Mariama', lastName: 'Diallo', platformRoles: ['resto_u_staff'] },
  // Not a student, two roles: two spaces.
  { phone: '770000005', firstName: 'Service', lastName: 'Communication', platformRoles: ['content_editor', 'resto_u_staff'] },
  // The academic team: its own announcements (exams, enrolments) in "Alertes campus".
  { phone: '770000006', firstName: 'Service', lastName: 'Scolarité', platformRoles: ['academic_editor'] },
  // The super admin's data entry: places, restaurants and shops ("Référencement").
  { phone: '770000007', firstName: 'Ndeye', lastName: 'Fall', platformRoles: ['place_editor', 'restaurant_editor', 'shop_editor'] },
];

/** Which public restaurants each menu publisher handles (by phone → restaurant slugs). */
export const restoAssignments: Record<string, string[]> = { '770000004': ['resto-1'], '770000005': ['resto-1', 'resto-2', 'resto-3'], '781112233': ['resto-2'] };

type SeedDish = { name: string; detail: string; status?: 'available' | 'low' | 'out' };

/**
 * University restaurants and a week of menus, rotating (day 0 = the day the seed runs). Day 0 mirrors the app's
 * former mock, Thiébou dieun "presque fini" at Resto 1.
 */
export const publicRestos: { slug: string; name: string; location: string; campus: Campus; coords: { lat: number; lng: number }; lunch: SeedDish[][]; dinner: SeedDish[][] }[] = [
  {
    slug: 'resto-1',
    name: 'Resto 1',
    location: 'Campus 1, près de la direction du CROUS',
    campus: 'campus1',
    coords: { lat: 16.0657, lng: -16.42605 },
    lunch: [
      [{ name: 'Vermicelle', detail: 'Poulet · légumes' }, { name: 'Mafé yap', detail: 'Riz · sauce arachide', status: 'low' }, { name: 'Thiébou dieun', detail: 'Riz au poisson', status: 'low' }],
      [{ name: 'Yassa poulet', detail: 'Riz · oignons' }, { name: 'Soupou kandia', detail: 'Riz · gombo' }],
      [{ name: 'Thiébou yapp', detail: 'Riz à la viande' }, { name: 'Salade niçoise', detail: 'Thon · œufs' }],
    ],
    dinner: [
      [{ name: 'Couscous poulet', detail: 'Semoule · légumes' }, { name: 'Spaghetti viande', detail: 'Sauce tomate' }, { name: 'Niébé', detail: 'Haricots · pain', status: 'low' }],
      [{ name: 'Ndambé', detail: 'Haricots · pain' }, { name: 'Omelette frites', detail: 'Œufs · pommes de terre' }],
    ],
  },
  {
    slug: 'resto-2',
    name: 'Resto 2',
    location: 'Campus 1, près de l’arrêt de bus',
    campus: 'campus1',
    coords: { lat: 16.06777, lng: -16.42155 },
    lunch: [
      [{ name: 'Pailla', detail: 'Riz · viande' }, { name: 'Thiou Carry', detail: 'Riz · poulet' }],
      [{ name: 'Mafé poulet', detail: 'Riz · sauce arachide' }, { name: 'Vermicelle', detail: 'Poulet · légumes' }],
    ],
    dinner: [
      [{ name: 'Ndambé', detail: 'Haricots · pain' }, { name: 'Omelette frites', detail: 'Œufs · pommes de terre', status: 'low' }],
      [{ name: 'Couscous', detail: 'Semoule · sauce' }, { name: 'Niébé', detail: 'Haricots · pain' }],
    ],
  },
  {
    slug: 'resto-3',
    name: 'Resto 3',
    location: 'Campus 2, près du Village J',
    campus: 'campus2',
    coords: { lat: 16.0574, lng: -16.4268 },
    lunch: [
      [{ name: 'Thiébou dieun', detail: 'Riz au poisson' }, { name: 'Domoda', detail: 'Riz · sauce tomate' }],
      [{ name: 'Yassa poisson', detail: 'Riz · oignons' }, { name: 'Lakh', detail: 'Mil · lait caillé' }],
    ],
    dinner: [
      [{ name: 'Spaghetti viande', detail: 'Sauce tomate' }, { name: 'Ndambé', detail: 'Haricots · pain' }],
    ],
  },
];

/**
 * Sunu Taxi: open trips starting soon after the seed runs (like the app's mock). Paid through the simulator.
 * Awa (77 000 00 02) stays free to try joining one.
 */
export const taxiTrips: { organizer: string; from: string; to: string; leaveInMinutes: number; seats: number; fare: number; passengers: string[] }[] = [
  { organizer: '771234567', from: 'UGB · Village E', to: 'Saint-Louis · Gare routière', leaveInMinutes: 45, seats: 4, fare: 3000, passengers: ['781112233'] },
  { organizer: '761234500', from: 'UGB · Entrée principale', to: 'Gandon · Marché', leaveInMinutes: 130, seats: 4, fare: 2000, passengers: [] },
];

/**
 * Caravans, as in the app's mock (constants/data.ts): times are relative to the seed run. Stop offsets are minutes
 * after departure. `tickets`: demo students who already paid (phone, pickup index, drop-off index).
 * Awa (77 000 00 02) has no ticket, to try booking; the Khoulé departure in 2 h is there to try boarding
 * (Modou 77 000 00 01 = owner, Cheikh 77 000 00 03 = scanner).
 */
type SeedStop = [place: string, offsetMin: number];
const ugbPickups: SeedStop[] = [['UGB · Village E', 0], ['UGB · Entrée principale', 10], ['Saint-Louis · Gare routière', 40]];
const toDakar: SeedStop[] = [['Louga · Station Total', 130], ['Kébémer · Carrefour', 160], ['Tivaouane · EDK', 210], ['Thiès · Mairie', 240], ['Rufisque · En face Sococim', 290], ['Dakar · Patte d’Oie', 320], ['Dakar · Colobane', 335]];
const fromDakar: SeedStop[] = [['Dakar · École normale', 0], ['Pikine · Station Total Bountou', 30], ['Fass Mbao · Arrêt ICS', 45], ['Rufisque · En face Sococim', 70], ['Diamniadio · Hôpital des enfants', 90], ['Thiès · Mairie', 135], ['Tivaouane · EDK', 165], ['Louga · Station Total', 225]];
const toUgb: SeedStop[] = [['UGB · Entrée principale', 300], ['UGB · Village E', 310]];

export const vehicles: { org: string; label: string; plate: string; capacity: number }[] = [
  { org: 'khoule', label: 'Bus 64 places', plate: 'DK-4821-BF', capacity: 64 },
  { org: 'khoule', label: 'Bus 64 places', plate: 'DK-5502-BF', capacity: 64 },
  { org: 'globe', label: 'Bus 64 places', plate: 'DK-7710-AZ', capacity: 64 },
  { org: 'amicale-zig', label: 'Bus 60 places', plate: 'ZG-1934-BC', capacity: 60 },
  { org: 'ndar', label: 'Minibus 32 places', plate: 'SL-2207-AC', capacity: 32 },
];

const H = 60;
const D = 24 * H;
export const departures: {
  plate: string; direction: 'aller' | 'retour'; from: string; to: string; inMinutes: number; pickups: SeedStop[]; dropoffs: SeedStop[];
  price: number; minPassengers: number; confirmByMinutesBefore?: number; tickets?: [phone: string, pickup: number, dropoff: number][];
}[] = [
  // Leaves soon: boarding is open (3 h before) for the organizer demo.
  { plate: 'DK-5502-BF', direction: 'aller', from: 'UGB', to: 'Dakar', inMinutes: 2 * H, pickups: ugbPickups, dropoffs: [toDakar[3]!, toDakar[6]!], price: 3500, minPassengers: 2, confirmByMinutesBefore: 60, tickets: [['771234567', 0, 1], ['781112233', 2, 0], ['761234500', 0, 1]] },
  { plate: 'DK-4821-BF', direction: 'aller', from: 'UGB', to: 'Dakar', inMinutes: 2 * D + 4 * H + 37, pickups: ugbPickups, dropoffs: toDakar, price: 3500, minPassengers: 40, tickets: [['771234567', 0, 6]] },
  { plate: 'SL-2207-AC', direction: 'aller', from: 'UGB', to: 'Dakar', inMinutes: 2 * D + 5 * H + 17, pickups: ugbPickups.slice(0, 2), dropoffs: toDakar.slice(3), price: 3000, minPassengers: 22 },
  { plate: 'DK-7710-AZ', direction: 'aller', from: 'UGB', to: 'Ziguinchor', inMinutes: 2 * D + 5 * H, pickups: ugbPickups, dropoffs: [['Kaolack · Gare routière', 250], ['Bignona · Carrefour', 560], ['Ziguinchor · Gare routière', 600]], price: 3500, minPassengers: 40 },
  { plate: 'ZG-1934-BC', direction: 'aller', from: 'UGB', to: 'Ziguinchor', inMinutes: 3 * D + H, pickups: ugbPickups.slice(0, 1), dropoffs: [['Ziguinchor · Gare routière', 600], ['Ziguinchor · Boucotte', 615], ['Ziguinchor · Lyndiane', 625]], price: 3200, minPassengers: 40, tickets: [['761234500', 0, 1]] },
  { plate: 'DK-4821-BF', direction: 'retour', from: 'Dakar', to: 'UGB', inMinutes: 6 * D + 6 * H, pickups: fromDakar, dropoffs: toUgb, price: 3500, minPassengers: 40, tickets: [['781112233', 5, 1]] },
  { plate: 'DK-7710-AZ', direction: 'retour', from: 'Ziguinchor', to: 'UGB', inMinutes: 5 * D + 22 * H, pickups: [['Ziguinchor · Gare routière', 0], ['Bignona · Carrefour', 40]], dropoffs: [['UGB · Entrée principale', 600], ['UGB · Village E', 610]], price: 3500, minPassengers: 40 },
  { plate: 'DK-7710-AZ', direction: 'aller', from: 'UGB', to: 'Dakar', inMinutes: 4 * D + H, pickups: ugbPickups, dropoffs: [toDakar[3]!, toDakar[5]!, toDakar[6]!], price: 3500, minPassengers: 40 },
  { plate: 'DK-5502-BF', direction: 'aller', from: 'UGB', to: 'Kaolack', inMinutes: 5 * D + 3 * H, pickups: [['UGB · Entrée principale', 0]], dropoffs: [['Louga · Station Total', 130], ['Diourbel · Gare routière', 230], ['Kaolack · Gare routière', 290]], price: 3000, minPassengers: 40 },
];

const DAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
/** The next given weekday (0 = Sunday) at least `min` days ahead, at hh:00 (Dakar = UTC). */
const next = (from: Date, weekday: number, h: number, min = 1) => {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), h));
  d.setUTCDate(d.getUTCDate() + min);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d;
};
const inDays = (from: Date, days: number, h: number) => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + days, h));
const aud = (a: Partial<import('../../src/modules/accounts/index.js').Audience> = {}) => ({ campuses: [], ufrs: [], regions: [], ...a });
const dayFr = (d: Date) => `${DAYS_FR[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS_FR[d.getUTCMonth()]}`;

/** The home screen's alerts and "À la une" (formerly mocks in the app), dated from the day the seed runs. */
export function seedAlerts(now: Date): { who: 'communication' | 'academic'; a: import('../../src/modules/alerts/alerts.types.js').AlertInput }[] {
  const vote = next(now, 4, 8, 2);
  const bourses = inDays(now, 4, 8);
  const exams = inDays(now, 21, 8);
  const culture = next(now, 6, 10, 2);
  return [
    {
      who: 'communication',
      // Campus 1 only (Village E is on Campus 1).
      a: { kind: 'campus', placement: 'banner', tag: null, title: 'Coupure d’eau · Village E', body: 'Demain de 10h à 16h : prévois des réserves.', icon: 'water-outline', tone: 'warning', href: null, eventAt: null, audience: aud({ campuses: ['campus1'] }), startsAt: now, endsAt: inDays(now, 1, 18), push: false },
    },
    {
      who: 'communication',
      // UFR SJP only.
      a: { kind: 'campus', placement: 'headline', tag: 'Élections', title: 'Élections des délégués', body: `UFR SJP · vote ${dayFr(vote)} · 8h-17h · amphi SJP`, icon: 'megaphone-outline', tone: 'info', href: null, eventAt: vote, audience: aud({ ufrs: ['SJP'] }), startsAt: now, endsAt: inDays(vote, 0, 18), push: false },
    },
    {
      who: 'communication',
      a: { kind: 'campus', placement: 'headline', tag: 'Bourses', title: `Paiement des bourses le ${dayFr(bourses).split(' ').slice(1).join(' ')}`, body: 'Virement sur Wave et Orange Money', icon: 'wallet-outline', tone: 'success', href: null, eventAt: bourses, audience: aud(), startsAt: now, endsAt: inDays(bourses, 1, 0), push: false },
    },
    {
      who: 'academic',
      // UFR SAT only.
      a: { kind: 'academic', placement: 'headline', tag: 'Examens', title: 'Examens du premier semestre', body: `UFR SAT · à partir du ${dayFr(exams)} · calendrier à la scolarité`, icon: 'school-outline', tone: 'info', href: null, eventAt: exams, audience: aud({ ufrs: ['SAT'] }), startsAt: now, endsAt: exams, push: false },
    },
    {
      // Prepared in advance: shows as "Programmée" in the communication space until it starts.
      who: 'communication',
      a: { kind: 'campus', placement: 'headline', tag: 'Culture', title: 'Journée culturelle des amicales', body: `${dayFr(culture)} · 10h · esplanade du Village E`, icon: 'musical-notes-outline', tone: 'info', href: null, eventAt: culture, audience: aud(), startsAt: inDays(culture, -2, 8), endsAt: inDays(culture, 0, 22), push: true },
    },
  ];
}

/** Banner prices (an admin changes them with PUT /admin/banner-packages/{code}). */
export const bannerPackages = [
  { code: 'jour', name: 'Une journée', days: 1, price: 1000 },
  { code: 'weekend', name: 'Trois jours', days: 3, price: 2500 },
  { code: 'semaine', name: 'Une semaine', days: 7, price: 5000 },
];

/** Colours of the generated demo pictures (gradients: no stock photos in the repo). */
export const demoPictures = {
  forfait: ['#5B3FD6', '#9B6BFF'],
  grillades: ['#E8590C', '#FFB347'],
  livraison: ['#0F9D58', '#7BD389'],
  soiree1: ['#1B1464', '#C2185B'],
  soiree2: ['#311B92', '#FF6F00'],
  soiree3: ['#880E4F', '#FFB300'],
  conference: ['#0D47A1', '#4FC3F7'],
} as const;

/** The home carousel (formerly a mock in the app): approved ads running from the seed day for a week. */
export const demoAds = [
  { picture: 'forfait', title: '-20 % sur tes forfaits internet', description: 'Offre étudiants valable jusqu’au 30 nov.', cta: { label: 'J’en profite', target: 'url', value: 'https://example.com/offre-etudiants' } },
  { picture: 'grillades', title: 'Chez Marie · Grillades', description: 'Menu étudiant à 1 000 FCFA ce soir', cta: { label: 'Voir', target: 'app', value: '/resto/r2' } },
  { picture: 'livraison', title: 'Livraison au pavillon', description: 'Gratuite pour ta première commande', cta: { label: 'Commander', target: 'app', value: '/(tabs)/resto?vue=restos' } },
] as const;

type SeedItem = { section: 'menu' | 'drink' | 'article'; category?: string; name: string; detail?: string; price: number; stock?: number };
const drink = (name: string, detail: string, price: number): SeedItem => ({ section: 'drink', name, detail, price });
const campusDrinks = [drink('Bissap', 'Jus d’hibiscus · 33 cl', 300), drink('Gingembre', 'Jus de gingembre · 33 cl', 300), drink('Eau minérale', 'Bouteille · 50 cl', 250)];

/** Private restaurants (mirroring the app's former mocks) and two shops, each with its owner (password: DEMO_PASSWORD). */
export const businesses: {
  kind: 'restaurant' | 'shop';
  name: string;
  specialties: string[];
  description: string;
  owner: { phone: string; firstName: string; lastName: string };
  address: string;
  campus: Campus;
  location: { lat: number; lng: number };
  services: { start: string; end: string }[];
  /** FCFA per zone (campus 1, campus 2, outside); null: no delivery there. */
  deliveryFees: { campus1: number | null; campus2: number | null; outside: number | null };
  colors: readonly [string, string];
  items: SeedItem[];
}[] = [
  {
    kind: 'restaurant', name: 'Khoulé & Frère', specialties: ['Sénégalais'], description: 'Les plats du pays, comme à la maison.', owner: { phone: '770000010', firstName: 'Ousmane', lastName: 'Khoulé' },
    address: 'Près du Village E', campus: 'campus1', location: { lat: 16.0603, lng: -16.4262 }, services: [{ start: '12:00', end: '15:00' }, { start: '19:00', end: '22:00' }], deliveryFees: { campus1: 200, campus2: 300, outside: 500 }, colors: ['#B45309', '#F59E0B'],
    items: [
      { section: 'menu', name: 'Mafé yap', detail: 'Riz · sauce arachide', price: 1500 },
      { section: 'menu', name: 'Thiébou dieun', detail: 'Riz au poisson', price: 1800 },
      { section: 'menu', name: 'Yassa poulet', detail: 'Riz · poulet · oignons', price: 1700 },
      ...campusDrinks,
    ],
  },
  {
    kind: 'restaurant', name: 'Chez Marie', specialties: ['Grillades'], description: 'Poulet braisé et dibi le soir.', owner: { phone: '770000011', firstName: 'Marie', lastName: 'Sène' },
    address: 'Campus 1 · pavillon A', campus: 'campus1', location: { lat: 16.0611, lng: -16.4249 }, services: [{ start: '12:00', end: '15:00' }, { start: '19:00', end: '23:00' }], deliveryFees: { campus1: null, campus2: null, outside: null }, colors: ['#9A3412', '#FB923C'],
    items: [{ section: 'menu', name: 'Poulet braisé', detail: 'Frites · salade', price: 2000 }, { section: 'menu', name: 'Dibi agneau', detail: 'Oignons · moutarde', price: 2500 }, drink('Jus d’orange', 'Pressé · 33 cl', 500)],
  },
  {
    kind: 'restaurant', name: 'Le Goût', specialties: ['Plats du jour'], description: 'Un plat différent chaque jour, près de la BU.', owner: { phone: '770000012', firstName: 'Abdou', lastName: 'Ndiaye' },
    address: 'Campus 1 · près de la BU', campus: 'campus1', location: { lat: 16.0629, lng: -16.4232 }, services: [{ start: '12:00', end: '16:00' }], deliveryFees: { campus1: 150, campus2: 250, outside: 450 }, colors: ['#166534', '#4ADE80'],
    items: [{ section: 'menu', name: 'Domoda', detail: 'Riz · sauce tomate', price: 1500 }, { section: 'menu', name: 'Soupe kandia', detail: 'Riz · gombo', price: 1700 }, ...campusDrinks],
  },
  {
    kind: 'restaurant', name: 'Chez Fatou', specialties: ['Riz & sauces'], description: 'À l’entrée du campus 2.', owner: { phone: '770000013', firstName: 'Fatou', lastName: 'Sarr' },
    address: 'Campus 2 · entrée', campus: 'campus2', location: { lat: 16.0571, lng: -16.4271 }, services: [{ start: '12:00', end: '15:00' }, { start: '19:00', end: '21:00' }], deliveryFees: { campus1: 0, campus2: 100, outside: 300 }, colors: ['#5B21B6', '#A78BFA'],
    items: [{ section: 'menu', name: 'Mafé', detail: 'Riz · sauce arachide', price: 1500 }, { section: 'menu', name: 'Thiou carry', detail: 'Riz · poulet', price: 1600 }, ...campusDrinks],
  },
  {
    kind: 'restaurant', name: 'Le Coin du Village E', specialties: ['Snacks'], description: 'Chawarmas et burgers jusqu’à 22h.', owner: { phone: '770000014', firstName: 'Ibou', lastName: 'Diagne' },
    address: 'Village E', campus: 'campus1', location: { lat: 16.0599, lng: -16.4266 }, services: [{ start: '10:00', end: '22:00' }], deliveryFees: { campus1: 100, campus2: 200, outside: 400 }, colors: ['#1E3A8A', '#60A5FA'],
    items: [{ section: 'menu', name: 'Chawarma', detail: 'Poulet · crudités', price: 1000 }, { section: 'menu', name: 'Burger frites', detail: 'Bœuf · fromage', price: 1500 }, { section: 'menu', name: 'Pain thon', detail: 'Thon · oignons', price: 500 }, drink('Jus d’orange', 'Pressé · 33 cl', 500)],
  },
  {
    kind: 'shop', name: 'Papeterie du Campus', specialties: ['Fournitures'], description: 'Cahiers, stylos, impressions et reliures.', owner: { phone: '770000015', firstName: 'Aliou', lastName: 'Ba' },
    address: 'Sous la BU', campus: 'campus1', location: { lat: 16.0627, lng: -16.4229 }, services: [{ start: '08:00', end: '20:00' }], deliveryFees: { campus1: null, campus2: null, outside: null }, colors: ['#0F766E', '#5EEAD4'],
    items: [
      { section: 'article', category: 'Fournitures', name: 'Cahier 200 pages', detail: 'Grands carreaux', price: 600, stock: 40 },
      { section: 'article', category: 'Fournitures', name: 'Stylo bleu', detail: 'Lot de 4', price: 400, stock: 60 },
      { section: 'article', category: 'Fournitures', name: 'Calculatrice Casio fx-92', price: 9000, stock: 5 },
      { section: 'article', category: 'Impression', name: 'Reliure mémoire', detail: 'Couverture transparente', price: 1500 },
    ],
  },
  {
    kind: 'shop', name: 'Boutique du Village C', specialties: ['Épicerie'], description: 'Le quotidien, crédit et boissons fraîches.', owner: { phone: '770000016', firstName: 'Mame', lastName: 'Diouf' },
    address: 'Entre les villages C et D', campus: 'campus1', location: { lat: 16.0598, lng: -16.4247 }, services: [{ start: '07:00', end: '23:00' }], deliveryFees: { campus1: 100, campus2: 200, outside: 400 }, colors: ['#BE185D', '#F9A8D4'],
    items: [
      { section: 'article', category: 'Épicerie', name: 'Pain', detail: 'Baguette', price: 150, stock: 80 },
      { section: 'article', category: 'Épicerie', name: 'Lait en poudre', detail: 'Sachet 400 g', price: 1800, stock: 20 },
      { section: 'article', category: 'Boissons', name: 'Coca-Cola', detail: 'Canette 33 cl', price: 500, stock: 48 },
      { section: 'article', category: 'Hygiène', name: 'Savon', detail: 'Pain de 200 g', price: 350, stock: 30 },
    ],
  },
];

/**
 * The campus places, positioned from OpenStreetMap (© OpenStreetMap contributors, ODbL). The team completes and
 * corrects them in the app's "Lieux" staff tab.
 */
type SeedPlace = { name: string; category: 'Études' | 'Restauration' | 'Services' | 'Sport' | 'Santé' | 'Administration' | 'Logement' | 'Culte' | 'Transport'; location: { lat: number; lng: number }; icon: string; area: string; campus: Campus | null; hours: string | null; description: string; photoUrls: string[] };
export const campusPlaces: SeedPlace[] = [
  {name: "Village A", category: "Logement", location: {lat: 16.06548, lng: -16.42074}, icon: "bed-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Village A du campus 1 (chambres partagées).", photoUrls: []},
  {name: "Village B", category: "Logement", location: {lat: 16.06475, lng: -16.42123}, icon: "bed-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Village B du campus 1 (chambres partagées).", photoUrls: []},
  {name: "Village C", category: "Logement", location: {lat: 16.06461, lng: -16.42211}, icon: "bed-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Village C du campus 1 (chambres partagées).", photoUrls: []},
  {name: "Village D", category: "Logement", location: {lat: 16.06476, lng: -16.42372}, icon: "bed-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Village D du campus 1 (chambres partagées).", photoUrls: []},
  {name: "Village E", category: "Logement", location: {lat: 16.06647, lng: -16.42374}, icon: "bed-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Village E du campus 1 (chambres partagées).", photoUrls: []},
  {name: "Village F", category: "Logement", location: {lat: 16.06648, lng: -16.42273}, icon: "bed-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Village F du campus 1 (chambres partagées).", photoUrls: []},
  {name: "Village G", category: "Logement", location: {lat: 16.06605, lng: -16.42171}, icon: "bed-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Village G du campus 1 (chambres partagées).", photoUrls: []},
  {name: "Village M", category: "Logement", location: {lat: 16.06693, lng: -16.42295}, icon: "bed-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Village M du campus 1 (chambres partagées).", photoUrls: []},
  {name: "Village Q", category: "Logement", location: {lat: 16.06765, lng: -16.42502}, icon: "bed-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Village Q du campus 1 (chambres partagées).", photoUrls: []},
  {name: "Village H", category: "Logement", location: {lat: 16.06343, lng: -16.42579}, icon: "bed-outline", area: "Campus 2", campus: "campus2", hours: null, description: "Village H du campus 2 (chambres individuelles).", photoUrls: []},
  {name: "Village I", category: "Logement", location: {lat: 16.06207, lng: -16.42631}, icon: "bed-outline", area: "Campus 2", campus: "campus2", hours: null, description: "Village I du campus 2 (chambres individuelles).", photoUrls: []},
  {name: "Village J", category: "Logement", location: {lat: 16.06254, lng: -16.42781}, icon: "bed-outline", area: "Campus 2", campus: "campus2", hours: null, description: "Village J du campus 2 (chambres individuelles).", photoUrls: []},
  {name: "Village K", category: "Logement", location: {lat: 16.06115, lng: -16.42749}, icon: "bed-outline", area: "Campus 2", campus: "campus2", hours: null, description: "Village K du campus 2 (chambres individuelles).", photoUrls: []},
  {name: "Village L", category: "Logement", location: {lat: 16.06407, lng: -16.42723}, icon: "bed-outline", area: "Campus 2", campus: "campus2", hours: null, description: "Village L du campus 2 (chambres individuelles).", photoUrls: []},
  {name: "Village N", category: "Logement", location: {lat: 16.06534, lng: -16.42781}, icon: "bed-outline", area: "Campus 2", campus: "campus2", hours: null, description: "Village N du campus 2 (chambres individuelles).", photoUrls: []},
  {name: "Village O", category: "Logement", location: {lat: 16.0656, lng: -16.42707}, icon: "bed-outline", area: "Campus 2", campus: "campus2", hours: null, description: "Village O du campus 2 (chambres individuelles).", photoUrls: []},
  {name: "Bibliothèque universitaire centrale", category: "Études", location: {lat: 16.06158, lng: -16.42285}, icon: "library-outline", area: "Campus pédagogique", campus: null, hours: "8h-22h · lun.-sam.", description: "Salles de lecture, wifi et prêt de livres avec la carte étudiant. Calme garanti pour réviser.", photoUrls: ["https://images.unsplash.com/photo-1521587760476-6c12a4b040da?w=800&q=70&auto=format&fit=crop", "https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=800&q=70&auto=format&fit=crop", "https://images.unsplash.com/photo-1568667256549-094345857637?w=800&q=70&auto=format&fit=crop"]},
  {name: "Amphi A · Madické Diop", category: "Études", location: {lat: 16.06146, lng: -16.42309}, icon: "school-outline", area: "Campus pédagogique", campus: null, hours: null, description: "Le plus grand amphi du campus : cours magistraux et conférences.", photoUrls: ["https://images.unsplash.com/photo-1524178232363-1fb2b075b655?w=800&q=70&auto=format&fit=crop", "https://images.unsplash.com/photo-1606761568499-6d2451b23c66?w=800&q=70&auto=format&fit=crop"]},
  {name: "Amphi B", category: "Études", location: {lat: 16.0619, lng: -16.42279}, icon: "school-outline", area: "Campus pédagogique", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Amphi C", category: "Études", location: {lat: 16.06119, lng: -16.42362}, icon: "school-outline", area: "Campus pédagogique", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Bâtiment A", category: "Études", location: {lat: 16.06192, lng: -16.4223}, icon: "easel-outline", area: "Campus pédagogique", campus: null, hours: null, description: "Bureaux et salles de cours.", photoUrls: []},
  {name: "Bâtiment B", category: "Études", location: {lat: 16.06212, lng: -16.42213}, icon: "easel-outline", area: "Campus pédagogique", campus: null, hours: null, description: "Bureaux et salles de cours.", photoUrls: []},
  {name: "Bâtiment C", category: "Études", location: {lat: 16.0623, lng: -16.42194}, icon: "easel-outline", area: "Campus pédagogique", campus: null, hours: null, description: "Bureaux et salles de cours.", photoUrls: []},
  {name: "Bâtiment D", category: "Études", location: {lat: 16.06232, lng: -16.42164}, icon: "easel-outline", area: "Campus pédagogique", campus: null, hours: null, description: "Bureaux et salles de cours.", photoUrls: []},
  {name: "Bâtiment E", category: "Études", location: {lat: 16.06185, lng: -16.42353}, icon: "easel-outline", area: "Campus pédagogique", campus: null, hours: null, description: "Bureaux et salles de cours.", photoUrls: []},
  {name: "Bâtiment F", category: "Études", location: {lat: 16.06149, lng: -16.42446}, icon: "easel-outline", area: "Campus pédagogique", campus: null, hours: null, description: "Bureaux et salles de cours.", photoUrls: []},
  {name: "Bâtiment J", category: "Études", location: {lat: 16.06252, lng: -16.42303}, icon: "easel-outline", area: "Campus pédagogique", campus: null, hours: null, description: "Bureaux et salles de cours.", photoUrls: []},
  {name: "Bâtiment L", category: "Études", location: {lat: 16.06113, lng: -16.42502}, icon: "easel-outline", area: "Campus pédagogique", campus: null, hours: null, description: "Bureaux et salles de cours.", photoUrls: []},
  {name: "UFR SEFS", category: "Études", location: {lat: 16.0638, lng: -16.42031}, icon: "school-outline", area: "Campus pédagogique", campus: null, hours: null, description: "Sciences de l’éducation, de la formation et du sport.", photoUrls: []},
  {name: "Centre de calcul", category: "Études", location: {lat: 16.06118, lng: -16.42409}, icon: "desktop-outline", area: "Campus pédagogique", campus: null, hours: null, description: "Salles informatiques.", photoUrls: []},
  {name: "MIAGE", category: "Études", location: {lat: 16.06076, lng: -16.42422}, icon: "desktop-outline", area: "Campus pédagogique", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Laboratoire LEIDI", category: "Études", location: {lat: 16.0617, lng: -16.42187}, icon: "flask-outline", area: "Campus pédagogique", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Incubateur", category: "Études", location: {lat: 16.06255, lng: -16.41924}, icon: "bulb-outline", area: "Est du campus", campus: null, hours: null, description: "Accompagnement des projets et startups étudiants.", photoUrls: []},
  {name: "Case culturelle", category: "Études", location: {lat: 16.06254, lng: -16.42694}, icon: "musical-notes-outline", area: "Campus 2", campus: "campus2", hours: null, description: "", photoUrls: []},
  {name: "Rectorat", category: "Administration", location: {lat: 16.06252, lng: -16.42123}, icon: "business-outline", area: "Allées des UFR", campus: null, hours: "8h-16h · lun.-ven.", description: "Direction de l’université. Bureau des objets trouvés au rez-de-chaussée.", photoUrls: ["https://images.unsplash.com/photo-1562774053-701939374585?w=800&q=70&auto=format&fit=crop", "https://images.unsplash.com/photo-1586773860418-d37222d8fce3?w=800&q=70&auto=format&fit=crop"]},
  {name: "Direction de la scolarité", category: "Administration", location: {lat: 16.06092, lng: -16.42523}, icon: "document-text-outline", area: "Campus pédagogique", campus: null, hours: "8h-16h · lun.-ven.", description: "Inscriptions, attestations et relevés de notes. Viens tôt en période d’inscription.", photoUrls: []},
  {name: "Direction du CROUS", category: "Administration", location: {lat: 16.06713, lng: -16.42607}, icon: "business-outline", area: "Campus 1", campus: "campus1", hours: "8h-16h · lun.-ven.", description: "Logement, restauration et bourses.", photoUrls: []},
  {name: "Agence comptable", category: "Administration", location: {lat: 16.06179, lng: -16.42052}, icon: "calculator-outline", area: "Près du Rectorat", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Poste de police", category: "Administration", location: {lat: 16.06051, lng: -16.42167}, icon: "shield-checkmark-outline", area: "Entrée du campus", campus: null, hours: "24h/24", description: "", photoUrls: []},
  {name: "Restaurant universitaire 1", category: "Restauration", location: {lat: 16.0657, lng: -16.42605}, icon: "restaurant-outline", area: "Campus 1", campus: "campus1", hours: "12h-15h · 19h-21h", description: "Restaurant universitaire : menus du jour au ticket. Les menus sont dans l’onglet Manger.", photoUrls: ["https://images.unsplash.com/photo-1567521464027-f127ff144326?w=800&q=70&auto=format&fit=crop", "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&q=70&auto=format&fit=crop"]},
  {name: "Restaurant universitaire 2", category: "Restauration", location: {lat: 16.06777, lng: -16.42155}, icon: "restaurant-outline", area: "Campus 1", campus: "campus1", hours: "12h-15h · 19h-21h", description: "Restaurant universitaire : menus du jour au ticket.", photoUrls: []},
  {name: "Cafétéria de l’UGB", category: "Restauration", location: {lat: 16.06519, lng: -16.42567}, icon: "cafe-outline", area: "Campus 1", campus: "campus1", hours: null, description: "", photoUrls: []},
  {name: "Le Virage", category: "Restauration", location: {lat: 16.06508, lng: -16.41926}, icon: "restaurant-outline", area: "Est du campus", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Service médical des étudiants", category: "Santé", location: {lat: 16.06663, lng: -16.42668}, icon: "medkit-outline", area: "Campus 1 · près du CROUS", campus: null, hours: "8h-18h · urgences 24h/24", description: "Consultations gratuites pour les étudiants inscrits, pharmacie de base et urgences.", photoUrls: ["https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?w=800&q=70&auto=format&fit=crop", "https://images.unsplash.com/photo-1538108149393-fbbd81895907?w=800&q=70&auto=format&fit=crop"]},
  {name: "Médecine du travail", category: "Santé", location: {lat: 16.06561, lng: -16.41959}, icon: "medical-outline", area: "Est du campus", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Clinique Laress", category: "Santé", location: {lat: 16.06838, lng: -16.41959}, icon: "medical-outline", area: "Nord-est du campus", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Complexe sportif", category: "Sport", location: {lat: 16.06375, lng: -16.42473}, icon: "football-outline", area: "Centre du campus", campus: null, hours: "7h-20h", description: "Terrains, piste d’athlétisme et salle de sport. Matchs inter-UFR le week-end.", photoUrls: ["https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=800&q=70&auto=format&fit=crop", "https://images.unsplash.com/photo-1551958219-acbc608c6377?w=800&q=70&auto=format&fit=crop"]},
  {name: "Terrain Valentin", category: "Sport", location: {lat: 16.06604, lng: -16.42487}, icon: "football-outline", area: "Campus 1", campus: "campus1", hours: null, description: "", photoUrls: []},
  {name: "Terrain Valentin 2", category: "Sport", location: {lat: 16.06653, lng: -16.42541}, icon: "football-outline", area: "Campus 1", campus: "campus1", hours: null, description: "", photoUrls: []},
  {name: "Terrain du campus 2", category: "Sport", location: {lat: 16.06315, lng: -16.42686}, icon: "football-outline", area: "Campus 2", campus: "campus2", hours: null, description: "", photoUrls: []},
  {name: "Tour de l’Œuf", category: "Sport", location: {lat: 16.06556, lng: -16.42283}, icon: "basketball-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Terrain de basket au cœur des villages.", photoUrls: []},
  {name: "Grande Mosquée de l’UGB", category: "Culte", location: {lat: 16.06403, lng: -16.42306}, icon: "moon-outline", area: "Centre du campus", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village A", category: "Culte", location: {lat: 16.06572, lng: -16.42085}, icon: "moon-outline", area: "Village A", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village C", category: "Culte", location: {lat: 16.06473, lng: -16.422}, icon: "moon-outline", area: "Village C", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village E", category: "Culte", location: {lat: 16.06643, lng: -16.42355}, icon: "moon-outline", area: "Village E", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village F", category: "Culte", location: {lat: 16.06632, lng: -16.4226}, icon: "moon-outline", area: "Village F", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village G", category: "Culte", location: {lat: 16.06623, lng: -16.42155}, icon: "moon-outline", area: "Village G", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village H", category: "Culte", location: {lat: 16.06348, lng: -16.42615}, icon: "moon-outline", area: "Village H", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village I", category: "Culte", location: {lat: 16.06225, lng: -16.42601}, icon: "moon-outline", area: "Village I", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village J", category: "Culte", location: {lat: 16.06228, lng: -16.42782}, icon: "moon-outline", area: "Village J", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village K", category: "Culte", location: {lat: 16.06154, lng: -16.42753}, icon: "moon-outline", area: "Village K", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village L", category: "Culte", location: {lat: 16.06402, lng: -16.42681}, icon: "moon-outline", area: "Village L", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village M", category: "Culte", location: {lat: 16.06771, lng: -16.42346}, icon: "moon-outline", area: "Village M", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Mosquée du village N", category: "Culte", location: {lat: 16.0648, lng: -16.42811}, icon: "moon-outline", area: "Village N", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Ecobank", category: "Services", location: {lat: 16.06483, lng: -16.4244}, icon: "card-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Agence et distributeur.", photoUrls: []},
  {name: "Distributeur Ecobank (UFR)", category: "Services", location: {lat: 16.06216, lng: -16.42172}, icon: "cash-outline", area: "Allées des UFR", campus: null, hours: null, description: "", photoUrls: []},
  {name: "Euréka (photocopies)", category: "Services", location: {lat: 16.06604, lng: -16.42236}, icon: "print-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Photocopies, impression et reliure.", photoUrls: []},
  {name: "Maison de l’Université", category: "Services", location: {lat: 16.06884, lng: -16.41818}, icon: "home-outline", area: "Nord-est du campus", campus: null, hours: null, description: "Hébergement des visiteurs.", photoUrls: []},
  {name: "Arrêt de bus", category: "Transport", location: {lat: 16.06693, lng: -16.42193}, icon: "bus-outline", area: "Campus 1", campus: "campus1", hours: null, description: "Bus vers Saint-Louis.", photoUrls: []},
  {name: "Parking du Rectorat", category: "Transport", location: {lat: 16.06215, lng: -16.42119}, icon: "car-outline", area: "Près du Rectorat", campus: null, hours: null, description: "", photoUrls: []},
];

/** Places of the first seed, now replaced (renamed, or made up). */
export const retiredPlaces = ['Bibliothèque universitaire', 'Rectorat · Scolarité', 'Amphithéâtre A', 'Resto 1', 'Barbier du Village E', 'Copy Center', 'Terrain de sport', 'Centre médical', 'Village H · Campus 2'];
