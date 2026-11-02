# 06 — Payments, caravans, Sunu Taxi, lost & found, notifications, real-time

## 1. Payment architecture

### 1.1 Principles
1. **Only the server decides that money arrived**: from a verified webhook, or from a server-to-provider status query. The app's return from checkout only triggers polling of `GET /payments/{ref}`.
2. **One `payments` document per attempt**, with a public `reference` that is sent to the provider as the merchant reference.
3. **Every step is idempotent**: webhook inbox unique keys, conditional transitions, unique refund keys.
4. **Payment knows nothing about orders, tickets or taxis.** It calls the purpose handler that each of those modules registers.

### 1.2 Provider adapter interface

```ts
interface PaymentProvider {
  id: 'wave' | 'orange_money' | 'simulated';
  createCheckout(p: {reference, amount, currency: 'XOF', description, successUrl, errorUrl, expiresAt}):
    Promise<{sessionId: string; checkoutUrl: string; expiresAt: Date}>;
  verifyWebhook(rawBody: Buffer, headers): VerifiedEvent | null;   // null => 401, not processed
  fetchStatus(sessionId: string): Promise<'pending' | 'succeeded' | 'failed' | 'expired'>; // reconciliation
  refund?(p: {sessionId, txnId, amount, idempotencyKey}): Promise<{refundId, status}>;
  payout?(…): …;  // later, Q-1/Q-2
}
```

**What we know about the real providers. Every point must be verified against the merchant documentation once access is granted:**

- **Wave (Checkout API).**
  - `POST /v1/checkout/sessions` takes `amount`, `currency=XOF`, `success_url`, `error_url` and `client_reference`. It returns `wave_launch_url`, which opens the Wave app.
  - Webhooks (`checkout.session.completed` / `payment_failed`) are signed with an HMAC-SHA256 `Wave-Signature` header (timestamp + body).
  - There is a refund endpoint per session and a separate Payout API.
  - Requires a **Wave Business merchant account** and API keys with the checkout and webhook scopes.
- **Orange Money Sénégal.**
  - There are two routes: the Orange Developer "OM Web Payment" API (OAuth2 client credentials → `webpayment` returns `payment_url`, `pay_token` and `notif_token`; the notification goes to `notif_url`; a transaction-status endpoint exists), or Sonatel's own merchant APIs (QR/OTP).
  - Which one we get depends on the merchant contract. OM refunds are often **not exposed by API**, so they may have to be handled manually (`refunds.status = manual_required`).
- **Alternative to evaluate:** a Senegalese **aggregator** (PayTech, PayDunya, CinetPay, InTouch…) gives one contract and one API covering Wave and OM. That means less integration and compliance work, but a higher fee per transaction and one more intermediary. **Recommendation:** decide before building the real adapters (Q-1).

### 1.3 Simulated provider (your requirement: "simulate the payment")

Enabled only when `PAYMENTS_SIMULATOR=true` **and** `NODE_ENV !== 'production'`; boot fails otherwise.

```
App ── POST /orders (or /bookings, /join) ─► API ─ creates payment(PENDING) ─► simulated.createCheckout()
   ◄── { checkoutUrl: http://<api>/api/v1/dev/payment-simulator/PAY_01H… } ──┘
App opens it with expo-web-browser ─► simulator page shows amount + purpose + buttons
   [Payer] [Échec] [Annuler] [Payer en retard] [Webhook en double]
Button ─► server builds a provider-shaped event, signs it with SIMULATOR_WEBHOOK_SECRET,
          POSTs it to /api/v1/payments/webhooks/simulated  (same verification + inbox + job path as Wave)
Page redirects to ugbcampus://paiement/retour?ref=PAY_…  ─► app polls GET /payments/PAY_…
```

- **"Payer en retard"** delays the webhook beyond the hold expiry to exercise the late-payment path.
- **"Webhook en double"** sends the same event ID twice to exercise deduplication.
- The real adapters drop in behind the same interface. `paymentMethod: 'wave' | 'orange_money'` maps to a provider through configuration (`PAYMENT_PROVIDER_WAVE=simulated|wave`), so the app doesn't change.

### 1.4 Webhook processing

```
POST /webhooks/:provider
  1. read raw body, verify signature → invalid: store (signatureValid=false), 401
  2. insert paymentEvents {provider, providerEventId}  → E11000 duplicate: 200 (no-op)
  3. enqueue job `payments.process-event` (jobId = event _id) → 200 immediately
worker: payments.process-event
  4. load payment by reference; check amount & currency match → mismatch: flag + alert, stop
  5. transition: updateOne({_id, status: {$in: ['created','pending','expired']}}, {$set: {status: 'succeeded', providerTxnId}})
     (also accepts 'expired' → that's the late-payment case)
  6. call handler.onSucceeded(payment) (idempotent: e.g. booking confirm keyed on bookingId)
       'fulfilled'      → payment.fulfillment = fulfilled
       'unfulfillable'  → create refund (idempotencyKey payment:<id>:unfulfillable) → refund job
  7. mark event processedAt; notify user (payment.updated over WS + notification)
Sweepers: unprocessed events > 2 min → re-enqueue; pending payments past expiresAt → fetchStatus() then expire.
```

### 1.5 Refunds and payouts
- Refunds are created inside the business transaction (unique idempotency key) and executed by a `payments.refund` job. Retries use exponential backoff. After 5 failures, or if the provider has no refund API, the refund becomes `manual_required` and appears in the finance admin list.
- Payouts (caravan organizers, taxi organizers) accrue in `payouts`. **Paying them out is manual** until the payout API and the legal model are settled (Q-1, Q-2).
- **Reconciliation:** a daily job compares the provider's settlement report (or status queries) against our `succeeded` payments, then alerts on missing or extra transactions.

---

## 2. Caravans: seat reservation and ticketing

### 2.1 Seat model
- Seats are numbered `1..capacity`, row-major, 4 per row. Seats `n % 4 ∈ {1, 0}` are windows (matching the frontend comment). Vehicle `blockedSeats` are excluded.
- **Auto-pick order** (follows the frontend; the spec phrases it differently, which we flag): the **front-most free window seat**, otherwise the front-most free seat. Candidate list = windows by ascending row, then the others by ascending row.

### 2.2 Booking flow

```
POST /caravans/departures/:id/bookings  (Idempotency-Key)
 1. guards: student, departure published|confirmed, now < bookingClosesAt, stops valid (dropoff after pickup)
 2. transaction:
      insert bookings {departureId, userId, seat, status:'held', seatActive:true, countsForLimit:true,
                       holdExpiresAt: now+10min, price: departure.price}
        E11000 on {departureId,userId}  → 409 ALREADY_BOOKED
        E11000 on {departureId,seat}    → explicit seat: 409 SEAT_TAKEN; auto: next candidate (lock-free retry)
      updateOne(departure {_id, seatsTaken < capacity}, {$inc: {seatsTaken: 1}})  → 0 matched: 409 NO_SEATS_LEFT
 3. create payment (purpose caravan_booking, expiresAt = holdExpiresAt) → checkout
 4. enqueue delayed job caravans.expire-hold (jobId hold:<bookingId>, delay 10 min)
→ 201 {booking, payment}
```

- **Expiry** (job + 1-min sweeper as a safety net): `updateOne({_id, status: 'held', holdExpiresAt ≤ now}, {status: 'expired', seatActive: false, countsForLimit: false})` plus `$inc seatsTaken −1`, in one transaction. The payment moves to `expired` (and the provider session is cancelled if supported).
- **Payment success:**
  - On time: `held → confirmed`, insert the ticket, `$inc seatsConfirmed`. If `seatsConfirmed ≥ minPassengers`, the departure moves to `confirmed` and everyone gets a notification.
  - Late (after expiry): **proposed rule (Q-5)** is to re-take the same seat if still free and confirm; otherwise auto-refund 100 % and notify "Paiement reçu trop tard, remboursé".
- **Minimum passengers:** a delayed job at `confirmBy`. If the departure is still `published` with `seatsConfirmed < minPassengers`, it moves to `cancelled`, every ticket is cancelled with a 100 % refund (`min_not_reached`), and everyone is notified. *Who decides, and whether the organizer can extend the deadline: Q-21.*

### 2.3 Tickets and QR
- Created at confirmation: `code` (6 random Crockford base32 characters, unique per departure, e.g. `7KQ2MX`), `version: 1`.
- **QR payload:** `UGB1.<base64url(JSON{t: ticketId, d: departureId, s: seat, v: version, k: keyId})>.<base64url(Ed25519 signature)>`.
  - It contains **no name, phone or student number.**
  - Anyone with the public key can verify it offline; only the server can create one.
  - Transfer increments `version`, so screenshots of the old QR are rejected (`stale_version`).
  - Cancellation is rejected (`cancelled`).
- **The QR is generated on the server on demand** (`GET /tickets/:id` returns the string) and rendered by `react-native-qrcode-svg` as today. Signing keys rotate by `keyId`.

### 2.4 Cancellation (server time)

```
fee     = (departureAt − now ≥ 24h) ? 0 : round(price × 0.10)
refund  = price − fee
refused if now ≥ departureAt, ticket boarded, status ≠ active
```

The ticket, the booking and the seat release go through one transaction, which also creates the refund record. The provider refund call runs in a job. Timezone handling: all comparisons use UTC instants, and Dakar is UTC+0 anyway. Display strings are formatted on the client as today.

### 2.5 Transfer (not "cancel + rebook")
- Rules: the recipient must be a **registered student**, not the sender, and not already holding a ticket for this departure. The ticket must be active, not boarded, and before the cutoff (proposed: departure − 2 h). Only one transfer can be pending.
- **Proposed flow (Q-4):** `pending` → the recipient gets a push and accepts or declines → `accepted` swaps the holder and bumps the version, in one transaction. A transfer expires at the earlier of 24 h or the cutoff. The frontend currently transfers instantly; if you prefer that, `accept` happens implicitly, with the same atomic swap.
- The purchaser keeps `countsForLimit` (anti-hoarding, as in the frontend), and **refunds go to the purchaser's payment** (Q-3).

### 2.6 Boarding (organizer)
- **Input:** a QR string or a typed code.
- **Checks:**
  1. The signature is valid and the `keyId` is known.
  2. The departure belongs to the actor's organization.
  3. The departure is today, or within the boarding window (departure − 2 h to arrival).
  4. The ticket is active and its version matches.
  5. The ticket is not already boarded (unique `activeBoarding`).
- **Typed codes:** they are **random**, so they can't be guessed from a seat number. Matching is scoped to the organization's departures in the boarding window. Typed codes are rate-limited to 30/min per scanner device.
- **Response:** the passenger's first name, last initial, seat and dropoff. A warning is added if they board at a stop other than the booked one (`atDifferentStop`), matching the frontend's messages.
- **Live sync:** every boarding publishes `boarding.updated` on `departure:<id>`, so all of the organizer's phones update.
- **Offline (Q-17):** `offline-pack` provides the manifest and public keys. The device verifies the signature and checks for duplicates locally, queues scans with `clientScanId`, and syncs via `/boardings/batch`. The server is final: if two phones boarded the same ticket offline, the first `receivedAt` wins and the second is stored as `duplicate`, then flagged to the organizer.
- **Counts:** `booked` = active tickets; `onBoard` = active boardings. Both come from the collections, not from counters on the client.

---

## 3. Sunu Taxi

- **Create:** the student must not be suspended (`users.taxi.suspendedUntil < now`, recomputed from `taxiStrikes` in the last 30 days) and must have no active trip. The organizer participant is inserted with `activeTrip: true`; the unique index enforces one active trip. The server computes `seatPrice = ceil(fare / seats / 50) × 50` and creates the trip conversation.
- **Join:** the seat counter and participant insert run in one transaction, then the participant waits in `pending_payment` (10 min) and the payment is created. Payment success → `joined`, plus the system message "X a rejoint le trajet". Expiry → `expired`, the seat is released.
- **Leave:**
  - `now < lockAt`: refund 100 %.
  - otherwise: no refund, and the seat counter is *not* reopened for sale. Proposed rationale: the seat is already paid for. **Q-8.**
- **Organizer cancel:**
  - All paid passengers are refunded 100 %.
  - If `now ≥ lockAt` and paid passengers > 0, a `taxiStrikes` record is inserted (unique `{tripId, userId}`).
  - At 3 strikes in 30 days: `suspendedUntil = now + 7 days`.
- **Hand-over:** offered to the earliest `joinOrder` passenger, who accepts within 10 min (proposed). On accept, roles swap in one transaction and the hand-over carries no strike. On decline or timeout, the offer goes to the next passenger, or the organizer is told to cancel.
- **Check-in:** idempotent (`checkedInAt` set once), plus the system line "X est là ✓".
- **Depart:** organizer only, allowed from `lockAt` (proposed). Sets `status: 'departed'` and creates the payout `paidPassengers × seatPrice` for the organizer. Absent passengers stay charged. `activeTrip` is cleared for everyone.
- **Lifecycle jobs:**
  - at `lockAt`: push "Places verrouillées"
  - at `departureAt + 15 min`: if not departed, clear `activeTrip`; whether the trip auto-completes or is disputed is Q-8
  - at `chatClosesAt`: the conversation becomes read-only
- **Chat access policy:**
  - `canRead`: organizer or participant with a status in `{joined, left after paying}`
  - `canWrite`: same set, and `now < chatClosesAt`, and participant status `joined`

  The policy is checked on **every** REST call and on every WebSocket subscription.
- **Trust & safety:** blocking hides the blocked person's messages from the blocker. Reporting a user triggers admin review.

---

## 4. Lost & found privacy architecture

| Data | Who can see it |
|---|---|
| Item public fields (name, details, where, spot, when, holder, photo) | Every student |
| Reporter identity | Masked `Moussa S.` only. Never the phone or student number. |
| `secret` (verification detail) | **The reporter only.** Encrypted at rest. |
| Claim `proof` | The reporter, plus the claimant (their own proof). Encrypted. |
| `ownerUserId` for scanned cards | Nobody through the API. Used only to notify the owner. |
| `ownerHint` "Awa D." | Proposed: shown to the finder after a card scan (as the frontend does today), **to confirm the scan worked**. Alternative: show nothing (Q-7). |
| Card number | **Never stored in clear**: HMAC hash only, for matching. Card images are refused by validation. |

**Card scan flow:**

1. The finder scans or types the number.
2. The server computes `HMAC(cardNumber)` and looks it up in `studentRegistry`, or in `studentProfiles` if there is no registry (Q-6).
3. Match → a found-card item is created with `ownerUserId` (private) and the owner gets the notification "Ta carte étudiant a été trouvée à la BU. Ouvre l'app pour la récupérer", with no finder identity. No match → the finder is told "Dépose-la au bureau des objets trouvés".
4. Every scan is logged in `cardScans`. More than N unmatched scans per user and day → throttled and flagged (an enumeration attempt).

**Ownership claims:**

1. "C'est à moi" requires a proof text.
2. The claim opens a 1:1 conversation with the reporter.
3. The reporter compares the proof with their secret, then accepts or rejects. **Clicking alone never transfers anything.**
4. For office-held items, `lost_office` staff verify identity at hand-over and close the item.

Rate limits: 5 claims per day per user, and one pending claim per item per user.

**Photos:** the found object is photographed in full, without its contents (UI hint). EXIF/GPS is stripped. Photos are stored public-read only after processing. Reported items are auto-hidden at 3 reports, pending moderation.

---

## 5. Notifications and background jobs

### 5.1 Creation and delivery are separate

```
any module ── notifications.notify({userId|audience, type, category, title, body, deepLink, dedupeKey})
   → insert notifications (unique {userId, dedupeKey}; duplicate = no-op)  [inside or after the business txn]
   → enqueue push.send (jobId notif:<id>)  → worker batches up to 100 per Expo request
   → store Expo tickets in pushDeliveries → push.receipts job (delay 15 min) → disable DeviceNotRegistered tokens
Sweeper (1 min): notifications with push.status=pending older than 2 min → re-enqueue.
Broadcast: POST /admin/broadcasts → job fans out by audience in pages of 1 000 users (cursor stored on the broadcast,
           resumable) → bulk insert notifications → push.send batches.
```

- **Preferences:** a category switched off means inbox only, no push. Transactional types (payment, ticket, transfer, security) ignore the preference for the inbox but respect it for push, except security alerts.
- **Deep links:** `data.url` uses the routes the app already handles (`/billet/<id>`, `/commande/<id>`, `/taxi/<id>`, `/trajet/<id>`, `/objet/<id>`, `/objet/discussion/<id>`, `/notifications`).
- **Local reminders:** meal reminders and the existing caravan/taxi reminders **stay on the device**. The server also sends the important ones (departure in 2 h, taxi lock, transfer received) because local reminders don't survive reinstalls or other devices.

### 5.2 Queues

| Queue | Trigger | Retry | Idempotency |
|---|---|---|---|
| `otp.send` | OTP request | 3, exponential from 2 s | jobId = challengeId + sendCount |
| `push.send` / `push.receipts` | notification | 5, exponential from 5 s | jobId notif:<id>; unique notification |
| `notifications.fanout` | broadcast | resumable cursor | broadcast cursor + unique dedupeKey |
| `payments.process-event` | webhook | 8, exponential | event unique; conditional transitions |
| `payments.reconcile` | repeat 5 min | — | status query, conditional update |
| `payments.refund` | refund created | 5 → manual_required | provider idempotency key = refund key |
| `caravans.expire-hold` | booking | 3 | jobId hold:<id>; conditional update |
| `caravans.confirm-check` | departure published | 3 | jobId confirm:<id> |
| `caravans.reminders` | ticket confirmed | 3 | dedupeKey |
| `taxi.lifecycle` | trip created | 3 | jobId taxi:<id>:<event> |
| `media.process` | upload | 3 | media status |
| `academics.change-notify` | entry moved | 3 | dedupeKey entry:<id>:<changedAt> |
| sweepers (holds, payments, events, notifications, orphans) | repeat 1 min | — | conditional updates only |

- **Several instances:** BullMQ hands each job to one worker. Stalled jobs can run again after a crash, which is why **every processor is idempotent** through conditional updates and unique keys. Repeatable jobs are registered with fixed keys, so N workers don't multiply them. *Test #10 checks this.*
- **Monitoring:** queue depth, failure rate and job age are exported to Prometheus. Failed jobs are kept 7 days. Bull Board is optional, behind admin auth, in non-production environments.

---

## 6. Real-time communication

- WebSocket gateway on every API pod (`/ws`), with authentication as described in `04-api.md`.
- **Cross-instance:** after a message is persisted, the module publishes `{topic, event}` on Redis `rt:<topic>`. Each pod subscribes, on behalf of its local sockets, only to the topics they need (reference-counted), and forwards the event. No in-memory state is shared between pods.
- **Authorization:** checked on subscribe through the owning module's policy, and re-checked every 5 min and when membership events arrive (e.g. a passenger leaves, which unsubscribes them).
- **Reconnection:** the client reconnects with backoff, re-authenticates and re-subscribes, then calls `GET /conversations/:id/messages?after=<lastId>` to fill gaps. Delivery is at most once over WebSocket; REST provides completeness.
- **Heartbeat:** ping every 25 s; dead sockets are dropped after 2 missed pongs.
- **Scale:** a few thousand sockets per pod is trivial. The sticky-session requirement is avoided because of the Redis fan-out.
