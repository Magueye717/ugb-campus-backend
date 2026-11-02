# 01 — Frontend discovery and integration map

Status: **draft for approval**. Source inspected: `ugb-campus/` (Expo SDK 58, Expo Router, branch `develop`).

All data is mock data, held in memory in React contexts (`context/*.tsx`) and in `constants/data.ts`. None of it persists across launches. The frontend has no HTTP layer yet (no `fetch`, no API client, no token storage).

---

## 1. What the app actually is

### 1.1 Navigation

| Group | Routes | Notes |
|---|---|---|
| Auth | `(auth)/welcome`, `login`, `register` (3 steps), `forgot` | Login form takes **phone + password only**; there is no student-number login in the UI. |
| Student tabs | `(tabs)/index` Accueil, `resto` Manger, `caravanes` Trajets, `lieux` Campus, `profil` | |
| Organizer tabs | `(organisateur)/activites`, `scanner`, `compte` | Guarded by `space === 'organizer'`. |
| Space switch | `/espace?vers=student\|organizer` | Neutral transition screen. Switching is client-only; the backend must authorize every call independently. |
| Detail / flows | `billet/[id]`, `caravane/[id]`, `commande/[id]`, `depart/[id]`, `lieu/[id]`, `objet/[id]`, `objet/declarer`, `objet/discussion/[id]`, `objet/scanner`, `panier`, `resto/[id]`, `services/[slug]`, `services/cours`, `services/objets`, `services/taxi`, `taxi/[id]`, `trajet/[id]` (taxi chat), `notifications` | |

### 1.2 Account model as the frontend sees it

- `AuthContext` exposes `user`, `organizer` (a single organization), `spaces: ('student'|'organizer')[]` and `space`.
- **Organizer accounts are created on a "web platform"**, per the code comments. The app only logs them in. That platform **does not exist**.
- There are two demo accounts, matched by phone number: `770000001` is organizer-only (`khoule`), and `770000002` is both student and organizer (`amicaleZig`).
- In-app sign-up creates student accounts only.
- An organizer-only account has **no student space**, so an organizer is not necessarily a student. This matters for the data model.

---

## 2. Screen → backend integration map

Legend: **R** = reads, **W** = writes persistent data, **Rule** = business rule currently simulated on the client (it must move to the server).

### 2.1 Authentication (`features/register/*`, `app/(auth)/*`)

| Screen / step | Backend need | Rules currently simulated |
|---|---|---|
| Register · Step 1 Identification | **R** account exists (student number OR phone) | Student number `^P\d{6}$`. Phone: 9 digits starting with 70/71/75/76/77/78, country code +221. "Ce compte existe déjà" banner. |
| Register · Step 2 OTP | **W** send OTP (SMS, WhatsApp, e-mail fallback), **W** verify | `OTP_LENGTH=4`, TTL 5 min, 5 attempts, resend after 60 s. Results: `invalid(attemptsLeft)` / `expired` / `locked`. E-mail channel needs `getLinkedEmail(studentId)` from a "university directory". |
| Register · Step 3 Profile | **W** create account | First name, last name (letters, spaces, hyphens). Campus `campus1\|campus2`, `onCampus`. Village from a per-campus list, room `^[A-Z]?\d{1,4}[A-Z]?$`. Password ≥ 8 characters with ≥ 1 digit. Terms accepted. **UFR / level are NOT collected**, although the mock `user` object has `ufr`, `filiere` and `niveau`. |
| Login | **W** session | Phone + password. |
| Forgot | **W** OTP + reset | Phone → code. |
| Profil | **R** me, **W** logout, update village/room (implied) | Shows UFR / filière / level / village / room / student number. |

### 2.2 Home (`(tabs)/index`, `components/home.tsx`)

| Element | Backend need | Notes |
|---|---|---|
| "À la une" headlines | **R** | `tag`, `title`, `subtitle`, relative `time`, `urgent` (the only items shown in red), icon / tint. Some headlines look like **auto-generated stock alerts** ("Thiébou dieun épuisé"). |
| Campus alert | **R** | A single active alert with an `href`. |
| Ad banners | **R** | `title`, `subtitle`, `cta`, colour, and either an `href` (in-app) or a `url` (sponsor site) or neither. |
| Service shortcuts | none | Static navigation; keep it on the client. |
| Bell badge | **R** unread count | |

### 2.3 Food

| Screen | Backend need | Rules simulated |
|---|---|---|
| Resto U (`RestoUBoard`) | **R** public menus by meal (lunch 12–15 h, dinner 19–21 h), status per dish `available\|low\|critical` | "Au ticket, sur présentation de la carte étudiant": **payment happens at the counter, not in the app.** |
| Private restaurants list (`RestoBoard`) | **R** restaurants grouped by campus, open/closed | `restoStatus(services, now)` computes the open state from hours, using the device clock. |
| `resto/[id]` | **R** restaurant, menus of the day, drinks | |
| `panier` (cart) | **W** order | One restaurant per cart. Delivery fee: `null` = no delivery, `0` = free. Pickup or delivery with an address, a note, and a payment method `wave\|om`. **Totals are computed on the client.** |
| `commande/[id]` | **R** order + live status | `received → preparing → ready → done`, advanced by client timers in the demo. Wording differs for delivery and pickup. |

### 2.4 Caravanes (inter-city buses)

| Screen | Backend need | Rules simulated |
|---|---|---|
| `CaravanBoard` | **R** departures (aller/retour), organizer card (kind, level, rating, trips), free seats, confirmation state | `caravanState`: booked ≥ `minPassengers` → confirmed; otherwise "missing N", and everyone is refunded 100 % if the target isn't reached by `confirmBy`. |
| `caravane/[id]` booking | **R** seat map; **W** booking + payment | Automatic pick: the **front-most free window seat**, otherwise the front-most free seat. Windows are seats 1 and 4 of each row of 4. Pickup / dropoff from the route stops. `SERVICE_FEE = 0`. **One ticket per student per departure, and transferred tickets still count** (anti-hoarding). |
| `billet/[id]` | **R** ticket + QR; **W** cancel, transfer | QR = `UGB-CARAVANE:<ticket>:<caravan>:<seat>:<pickup>` (**unsigned, forgeable**). Cancellation: full refund ≥ 24 h before departure, then 10 % fee, impossible once departed. Transfer by phone number is instant, with no acceptance step. |
| Local reminders | none | `scheduleCaravanReminder` stays on the device. |

### 2.5 Organizer space

| Screen | Backend need | Rules simulated |
|---|---|---|
| `activites` | **R** the organization's departures | Empty state "Aucun départ publié". **There is no screen to create a departure**; that belongs to the web platform. |
| `scanner` (`TicketScanner`, `useTicketCheck`) | **W** boarding | QR or typed code (e.g. `TC305` = caravan `c3`, seat `05`: **predictable**). Results: wrong departure, unknown/cancelled, already on board (warning), boarded at a different stop than booked (warning). |
| `depart/[id]` | **R** manifest grouped by stop, booked vs on-board counts; **W** "le bus repart de cet arrêt" (stop left), unboard | Shows each passenger's **name and phone**. A stop with nobody getting on or off is optional. The code comment asks for scans to **sync between the organizer's phones and queue while offline**. |
| `compte` | none yet | Team, payments received and help are menu entries only (**placeholders**). |

### 2.6 Sunu Taxi (`TaxiContext`, `useTaxiActions`, `taxi/[id]`, `trajet/[id]`)

Rules currently simulated:

- Propose a trip: from, to, departure, seats (organizer included) and total fare.
- **Seat price** = `ceil(fare / seats / 50) * 50`. The organizer covers any empty seats.
- **Passengers pay when joining**, and the money is "blocked until departure".
- **One active trip per student** (organized or joined); a trip counts as active until 15 min after its time.
- **Leaving:** a full refund if more than 30 min before departure. After the lock (≤ 30 min), there is no refund: "elle sert à payer le taxi".
- **Organizer cancels:**
  - With no passengers: free.
  - With passengers: all of them are refunded 100 %.
  - If this happens **inside the 30-min lock**, it counts as a **strike**. **3 strikes in 30 days → Sunu Taxi suspended for 7 days.**
- **Hand-over:** the organizer passes the trip to the first passenger who joined, with no strike. In the mock the passenger accepts instantly; the real flow should ask them first.
- **Check-in:** "Je suis là", via a button or a quick reply, once per person.
- **"On est partis"** (organizer only): the organizer is paid `(passengers − 1) × seatPrice`. Absent passengers' seats stay paid.
- **Chat:** open only to the organizer and paying passengers, read-only from 2 h after departure. Quick replies, a pinned taxi description, system lines, unread counts, and **blocking** a user.

### 2.7 Lost & found (`LostContext`, `objet/*`, `LostBoard`)

Rules currently simulated:

- **Kinds:** `student-card`, `id-card`, `object`. Each category has a public hint and a secret hint.
- **Cards are never photographed.** A found object requires a photo; for a lost object the photo is optional.
- **Student card found** → it goes through the scanner (barcode or typed number). The directory returns **only a masked owner name ("Awa D.")** and the owner is notified. If the owner is unknown, the card must go to the office.
- **Public fields:** name, details, where, spot, when, holder (`office\|finder`), masked declarer name (`by`). The **secret** stays on the declarer's side.
- **"C'est à moi"** → the proof is sent to the finder and opens a conversation. **"Je l'ai trouvé"** on a lost item opens a conversation with the owner.
- **Mark returned** closes the case and the discussion.
- Safety tip, quick replies, and an office location with hours.
- **Format mismatch:** the student number in the registration flow is `P232055`, while the card barcode in the directory is `20230456789`.

### 2.8 Campus places (`PlacesBoard`, `lieu/[id]`, `PlacesMap`)

- **R** places: name, category (Études / Restauration / Services / Sport / Santé), description, area, coordinates, 1–3 photos and opening hours as text. Search and category filter.
- Directions open Apple Plans or Google Maps from the coordinates, so no backend routing is needed.

### 2.9 Courses, scholarships, notifications

| Screen | Backend need | Notes |
|---|---|---|
| `services/cours` | **R** timetable for one week | Entries have a CM/TD/TP kind, room, teacher and `movedFrom`, plus a banner for moved classes. Requires knowing the student's group, which is **not collected**. |
| `BoursesBoard` | **R** next payment date + method | A single global message; "detailed tracking coming soon". |
| `notifications` | **R** inbox with filters Tout / Social / Cours / Paiements, **W** mark read | Push: `data.url` deep link opened by `useNotificationRouting`. `lib/notifications.ts` has a `TODO: send token to backend`. Meal reminders and caravan/taxi reminders are **local**. |

### 2.10 Placeholders (no backend scope until specified)

- `services/inscription`
- The `services/[slug]` fallbacks: `tickets`, plus the generic "Bientôt disponible".
- Organizer `compte`: team, payments received, help.
- Detailed scholarship tracking.

> The caravans tab does have a real **"Mes billets"** list (tickets held). The placeholder is only the `services/tickets` slug page.

---

## 3. Persistent mutations (complete list)

1. Create account, verify phone, reset password, log in / log out, update profile (village / room).
2. Register a push token; mark notifications read.
3. Place a food order; restaurant staff advance its status (no UI yet).
4. Book a caravan seat (hold → pay → ticket); cancel a ticket; transfer a ticket.
5. Board a passenger (scan or code), unboard, mark a stop as left.
6. Taxi: create, join (pay), leave, cancel, hand over, check in, depart, pin the vehicle, chat, block a user.
7. Lost & found: declare (with photo upload), scan a card, claim, report found, chat, mark returned.
8. Admin / content (no UI): announcements, alerts, ads, places, menus and stock, departures, organizations, timetable, scholarship dates.

## 4. Business rules that must move server-side

| Rule | Location today |
|---|---|
| Price, delivery fee and order total | `panier.tsx` |
| Restaurant open/closed (device clock and timezone) | `restoStatus` |
| Seat availability, auto seat pick, one ticket per student per departure | `caravane/[id].tsx`, `TicketsContext` |
| Cancellation refund (24 h / 10 %) | `cancellationRefund` |
| Minimum passengers / `confirmBy` refund | display only, never enforced |
| QR validity, duplicate boarding, wrong departure | `useTicketCheck` |
| Taxi seat price, lock, refunds, strikes, suspension, one active trip, chat window, hand-over, payout | `TaxiContext`, `useTaxiActions` |
| OTP TTL / attempts / lock | `features/register/auth.ts` |
| Lost-card owner lookup and masking | `studentDirectory` |
| Order status progression | client timers |

## 5. Relationships between features

- **Payments** serve food orders, caravan bookings and taxi seats. Refunds come from caravan cancellations, caravan minimum not reached, taxi leave/cancel, and possibly order rejection.
- **Messaging** serves taxi trip chats (a group) and lost-item claims (1:1).
- **Notifications** are produced by every module: order status, booking confirmed, transfer received, departure confirmed or cancelled, taxi events, lost-card scan, claims, class moved, announcements.
- **Organizations** own caravan departures (and later restaurants). Memberships drive the organizer space and the scanner rights.
- **Student profile** (campus, village, academic group) drives announcement targeting, timetable and delivery address defaults.

## 6. Frontend changes that will be needed in Phase 8 (kept minimal)

- An API client and token storage. This adds **`expo-secure-store`** for the refresh token, which is a new native dependency and needs a dev build.
- Replace the bodies of `features/register/auth.ts` and the contexts with API calls; screens keep their props and flows.
- The QR value comes from the server (a signed token) instead of being composed on the client.
- Payment: open `checkoutUrl` with `expo-web-browser` (already installed), return via the `ugbcampus://` scheme, then poll the payment status.
- Push token registration, which is already marked `TODO`.
- The ticket screen shows the server-issued **short code** (random, not `TC305`).
- Optional: a login field that accepts a phone **or** a student number.
