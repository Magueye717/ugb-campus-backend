# 08 — Technical risks and open business questions

> **Q-1, Q-2, Q-3, Q-4, Q-6, Q-8, Q-12 are answered: see [09-decisions.md](09-decisions.md).** The others keep their defaults.

The questions are sorted by impact: **money, then safety, then privacy, then ownership, then everything else**. Each one shows the **default** I will use if it isn't answered, and that default is always the most conservative option. Nothing in the 💰 group goes live with real money until it is answered.

## Open questions

### 💰 Money

**Q-1 · Merchant of record and provider access.**
- Who signs the Wave Business and Orange Money merchant contracts: UGB, a student association, or a company?
- Should we integrate them directly, or go through an aggregator (PayTech, PayDunya…)?
- *Default:* the simulated provider only. The real adapters are built once the API documentation and sandbox keys are available.

**Q-2 · Holding and redistributing money.**
- Sunu Taxi ("argent bloqué jusqu'au départ", then "versés sur ton compte") and caravans (paying organizers, "nouveau" organizers paid after arrival) make the platform **collect money for third parties and redistribute it**.
- In the WAEMU zone (BCEAO rules on payment services and e-money), this may require an approved partner or a licence.
- Who pays organizers out, when, and is there a platform commission? `SERVICE_FEE` is 0 today.
- *Default:* payouts are recorded in a ledger and executed manually.

**Q-3 · Refund destination for transferred tickets.**
- When the recipient of a transfer cancels the ticket, who gets the refund: the original purchaser's payment method, or the recipient?
- *Default:* the purchaser, because they paid. Cancellation by the recipient is allowed, with the refund going to the purchaser.

**Q-4 · Transfer acceptance and cutoff.**
- Must the recipient accept, or is the transfer instant as in the frontend today?
- What is the latest time before departure that a transfer is allowed?
- Must the recipient be a registered student?
- *Default:* the recipient accepts within 24 h; cutoff at departure − 2 h; the recipient must be a registered student.

**Q-5 · Hold duration and late payments.**
- *Default:* a 10 min hold.
- Late payment: re-take the same seat if it is still free, otherwise refund 100 % automatically.

**Q-10 · Food order cancellation and rejection.**
- Can a student cancel after paying? Before the restaurant starts preparing?
- If the restaurant rejects an order, is the refund automatic?
- Who delivers, and is there any proof of delivery?
- *Default:* cancellation only before payment; a restaurant rejection refunds 100 %; no proof of delivery.

**Q-9 · Fees on small amounts.** A taxi seat can cost as little as 500–750 FCFA. Provider fees (Wave is about 1 %) may make refunds or payouts lose money. Confirm the minimum fare.

**Q-21 · Caravan minimum passengers.**
- Is the departure automatically cancelled with 100 % refunds when the minimum isn't reached at `confirmBy`?
- Can the organizer go ahead anyway, or extend the deadline?
- *Default:* automatic cancellation and refunds; the organizer may confirm manually before `confirmBy`.

### 🛡️ Safety and trust

**Q-8 · Sunu Taxi details.**
- **Strikes:** the frontend's rule is that an organizer cancelling within 30 min of departure, with paying passengers, earns a strike, and 3 strikes in 30 days suspend Sunu Taxi for 7 days. Confirm. Do passengers get strikes for no-shows or late leaves? *Default: no.*
- Can a student still **join** after the lock? *Default: yes, until departure.*
- When a passenger leaves after the lock, is their seat resold? *Default: no.*
- **Hand-over:** how long does the first passenger have to accept, and does the old organizer stay in as a passenger? *Default: 10 min, then the old organizer leaves the trip and is refunded nothing (they pay no seat).*
- When can "On est partis" be pressed, and what protects passengers from an organizer who presses it without going? *Default: allowed from `lockAt`; a passenger can report within 2 h, which freezes the payout.*
- If "On est partis" is never pressed: auto-complete, or dispute? *Default: freeze the payout and refund passengers who didn't check in.*

**Q-17 · Offline scanning.** Is offline boarding needed for v1? There is no network between towns, but the first stop is on campus. *Default:* online first in v1, with the data model ready for offline mode (`clientScanId`, offline pack).

### 🔒 Privacy

**Q-6 · Student identity.**
- Can the university provide a **registry export** (student number, name, card barcode, UFR / level)?
- Without one, anyone can register with someone else's student number and squat it.
- Two formats are in play: `P232055` in sign-up and `20230456789` on the card barcode. How do they relate?
- *Default:* accounts start `unverified`. An admin can reassign a squatted number after an identity check. Card scans fall back to matching on student number.

**Q-7 · Card scan disclosure.** Should the finder see the masked owner name "Awa D.", as the frontend does today, or only "Propriétaire prévenu"? *Default:* the masked name, as the frontend expects it.

**Q-16 · Passenger phone numbers in the manifest.** The frontend shows phone numbers to organizers. Are they needed, for example to call late passengers? *Default:* visible to `owner` and `manager`, hidden from `scanner`, and the manifest is unavailable 48 h after arrival.

**Q-20 · Retention and the CDP declaration.** *Proposed defaults:*

| Data | Retention |
|---|---|
| Chats | 90 days after they close |
| Notifications | 180 days |
| Card scans | 180 days |
| Audit logs | 2 years |
| Financial records | 10 years (accounting) |
| Lost items | auto-closed after 60 days |

### 🏷️ Ownership and administration

**Q-12 · There is no web platform.** Organizers, departures, vehicles, restaurants, announcements, menus and the timetable all need back-office screens.
- *Proposed:* deliver complete admin and organizer APIs, plus Swagger UI as a temporary back office in non-production environments.
- Do you want a small admin web app later? It would be a separate project.

**Q-11 · Resto U.**
- The app only shows menus and stock status; payment happens at the counter with paper tickets. The spec mentions entitlements and ticket consumption, but nothing in the frontend uses them, so they are **not built until the university's ticket process is described**.
- Who updates the stock (Resto U staff, from a phone)?
- Should the "épuisé" headlines be **generated automatically** from stock changes? *Default:* yes, as `source: 'stock_auto'` headlines with a 2 h expiry.

**Q-13 · Courses.**
- Where does the timetable come from: a CSV export, manual entry, or another system?
- Sign-up doesn't ask for UFR, filière, level or group, but the timetable and targeting need them.
- *Proposed:* add these fields to the profile, from the registry or chosen by the student, and import the timetable from CSV.

### ⚙️ Other

**Q-14 · OTP delivery.**
- Which SMS provider (Orange SMS API Sénégal, or an international one)?
- WhatsApp OTP needs the Meta WhatsApp Business API.
- The e-mail fallback needs the university directory (`getLinkedEmail`).
- Can we use 6 digits instead of 4?
- *Default:* SMS through one adapter; WhatsApp and e-mail only after the providers are chosen.

**Q-15 · Login by student number.** The spec asks for it, but the UI only offers a phone field. *Default:* the API accepts both; the UI change is optional.

**Q-18 · Local MongoDB at `localhost:27017`.** Is it running as a **replica set**? Transactions require one.
- If it isn't, either restart it with `--replSet rs0` and run `rs.initiate()` once, or use the compose Mongo service.
- *Default:* the configuration supports both, and boot fails with a clear message if transactions aren't available.

**Q-19 · Hosting.** Which provider and region: a local VPS, AWS, or Atlas? And which object storage? *Default:* everything in Docker; any S3-compatible storage.

**Q-22 · Organizer ratings and levels.** The levels ("verifie" after 3 trips rated 4/5 or more…) depend on ratings, but there is no rating screen. *Default:* an admin sets the level manually; a rating flow comes later.

## Technical risks

| Risk | Impact | Mitigation |
|---|---|---|
| Real payment API constraints differ from these assumptions (OM refunds, webhook formats) | Payment flows need changes | Adapter interface, simulated provider, a reconciliation job and a manual refund path from day 1 |
| Standalone local Mongo (no transactions) | Booking and refund flows break in dev | Detected at boot; compose provides a replica set |
| Caravan sale rush on a few departures | Contention, bad UX | Lock-free unique-index allocation, auto-pick retries, short-TTL list cache, k6 test before the first holiday rush |
| SMS cost and fraud | Money lost to SMS pumping | +221 only, per-phone and per-IP limits, daily budget alert |
| No official identity source | Account squatting, wrong card-owner matches | Q-6, admin reassignment flow, audited |
| Expo push dependency | Missed notifications | The inbox is the source of truth; FCM/APNs remain possible behind the same adapter |
| Frontend integration needs a new native module (`expo-secure-store`) | A dev build is required | Planned for Phase 8; no other native additions |
| Scope creep from placeholders | Delay | Placeholders listed and kept out of scope (`01-frontend-discovery.md` §2.10) |
| Legal model for holding funds (Q-2) | Launch blocker for taxi and caravan payouts | Decide early; the ledger keeps the system correct while payouts stay manual |
