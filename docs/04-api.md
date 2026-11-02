# 04 — REST API specification (v1)

Base: `/api/v1`. JSON only, except media upload (multipart). OpenAPI 3.1 is generated from the TypeBox schemas and served at `/docs` (disabled or behind basic auth in production).

## Conventions

- **Auth:** `Authorization: Bearer <accessToken>`.
- **Guards:**
  - `public`: no token.
  - `user`: any authenticated user.
  - `student`: has a student profile.
  - `org:<roles>`: active membership of the organization in the path with one of these roles.
  - `platform:<role>`: platform role.
  - Ownership rules are checked in services and noted as *(own)*.
- **`Idempotency-Key`** (UUID) is **required** on endpoints marked 🔁.
- **Errors:** `application/problem+json`:

  ```json
  { "type": "https://api.ugb-campus.sn/errors/seat-taken", "title": "Seat taken", "status": 409,
    "code": "SEAT_TAKEN", "message": "Cette place vient d’être prise. Choisis-en une autre.", "requestId": "…" }
  ```

- **Status codes:**
  - 200 OK, 201 created, 202 accepted (async), 204 no content
  - 400 validation, 401 unauthenticated, 403 forbidden
  - 404 not found, also used **instead of 403 for other users' resources** to avoid revealing that they exist
  - 409 conflict / invalid state, 410 expired, 422 business rule, 423 locked, 429 rate limited
  - 503 provider unavailable
- **Lists:** `?limit=20&cursor=…` → `{ items: [...], nextCursor: string | null }`. Filters and sorting are explicit query parameters (allowlisted).
- **Responses are DTOs:** never raw documents, never `_id` (we expose `id`), never internal flags (`seatActive`, `ownerUserId`, `secretEnc`…).

---

## Auth — `identity`

| Method & path | Guard | Body → Response | Notes |
|---|---|---|---|
| POST `/auth/register/check` | public | `{studentNumber, phone}` → `{available: boolean, conflict?: 'student_number' \| 'phone'}` | Required by the "Ce compte existe déjà" UX. **This inherently allows enumeration**, so: 10/h per IP, 5/h per phone, CAPTCHA hook ready. Trade-off documented. |
| POST `/auth/otp` | public | `{phone, purpose: 'register'\|'reset_password', channel}` → 202 `{challengeId, expiresIn: 300, resendAfter: 60, codeLength}` | For `reset_password`, an unknown phone gets 404 `ACCOUNT_NOT_FOUND` and no code (09-decisions.md). |
| POST `/auth/otp/{challengeId}/resend` | public | `{channel}` → 202 | |
| POST `/auth/otp/{challengeId}/verify` | public | `{code}` → `{verificationToken}` (15 min, single use, bound to phone + purpose) | 400 `OTP_INVALID {attemptsLeft}`, 410 `OTP_EXPIRED`, 423 `OTP_LOCKED`. Matches `VerifyResult` in the frontend. |
| POST `/auth/register` | public | `{verificationToken, studentNumber, firstName, lastName, campus, onCampus, village?, room?, password, termsVersion}` → 201 `{user: Me, tokens}` | Re-checks uniqueness in a transaction. Normalizes the phone to E.164. |
| POST `/auth/login` | public | `{identifier, password, device}` → `{tokens, me}` | `identifier` = phone or student number. Unknown account → 404 `ACCOUNT_NOT_FOUND`, wrong password → 401 `WRONG_PASSWORD` (09-decisions.md). Progressive lockout. |
| POST `/auth/refresh` | public | `{refreshToken}` → `{tokens}` | Rotation. Reuse → the family is revoked, 401 `SESSION_REVOKED`. |
| POST `/auth/logout` | user | `{refreshToken}` → 204 | |
| POST `/auth/logout-all` | user | → 204 | Revokes all sessions |
| POST `/auth/password/reset` | public | `{verificationToken, newPassword}` → 204 | Revokes all sessions and notifies the user |
| PUT `/auth/password` | user | `{currentPassword, newPassword}` → 204 | Revokes the other sessions |

`tokens = {accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt}`

## Me — `accounts`, `organizations`

| Method & path | Guard | Notes |
|---|---|---|
| GET `/me` | user | `{id, firstName, lastName, initials, phoneMasked, student?: {studentNumber, campus, onCampus, village, room, ufr, filiere, niveau, verified}, spaces: ('student'\|'organizer')[], organizations: [{id, name, category, level, roles}], payoutPhoneMasked, email: {address, verified} \| null, avatarUrl, location: {lat, lng, accuracyM, updatedAt} \| null}`. **This drives the `spaces` in `AuthContext`.** |
| PATCH `/me/student-profile` | student | `{onCampus, village, room}` (studentNumber and name are immutable; changed by admins only) |
| GET/PUT `/me/notification-preferences` | user | `{social, cours, paiements}` |
| PUT `/me/email` · DELETE `/me/email` | user | `{email}`. Unverified, unique (409 `EMAIL_TAKEN`). 10/h per user. |
| PUT `/me/location` · DELETE `/me/location` | user | `{lat, lng, accuracyM?}`. Stored as GeoJSON, visible only to the user. 60/h per user. |
| PUT `/me/avatar` | user | *With the media module:* `{mediaId}` from `POST /media`. |
| POST `/me/devices` | user | `{token, platform, appVersion}` → 204 (upsert, moves the token to this user) |
| DELETE `/me/devices/{token}` | user | |
| POST `/me/blocks` · DELETE `/me/blocks/{userId}` | user | Blocking in chats |

## Home & content — `content`

| Method & path | Guard | Notes |
|---|---|---|
| GET `/home` | user | `{headlines: Headline[≤10], alert: Alert \| null, ads: Ad[≤5], unreadNotifications}`. Filtered by audience (campus / UFR / level), cached 30 s per audience key. |
| GET `/announcements?type=headline&cursor` | user | Full list |
| POST `/admin/announcements` · PATCH `/admin/announcements/{id}` · POST `…/{id}/publish` · POST `…/{id}/archive` | platform:content_editor | Only these roles can set `official: true`. Audited. |

## Places — `places`

| Method & path | Guard | Notes |
|---|---|---|
| GET `/places?category=&q=&near=lat,lng` | user | `{id, name, category, area, description, coords: {lat, lng}, photos: url[], hours, icon}` |
| GET `/places/{id}` | user | Plus external directions links (`https://maps.apple.com/?daddr=…`, `https://www.google.com/maps/dir/?api=1&destination=…`) |
| POST/PATCH/DELETE `/admin/places…` | platform:admin | |

## Food — `food`

| Method & path | Guard | Notes |
|---|---|---|
| GET `/resto-u/menus?date=` | user | `[{restaurant: {id, name}, hoursLabel, open, lunch: Dish[], dinner: Dish[]}]` with `Dish = {id, name, detail, status}` |
| PATCH `/admin/resto-u/menus/{menuId}/dishes/{dishId}` | platform:resto_u_staff | `{status?, portionsLeft?}` (optimistic `ifUpdatedAt`) |
| PUT `/admin/resto-u/menus` | platform:resto_u_staff | Create the day's menu |
| GET `/restaurants?campus=` | user | Grouped `[{campus: {id, name}, restaurants: [{id, name, kind, hoursLabel, open, statusLabel, deliveryFee, photo, location}]}]`. `open` and `statusLabel` are computed on the server (Africa/Dakar). |
| GET `/restaurants/{id}` | user | Plus `menus: Item[]` and `drinks: Item[]`, only `available` items |
| POST `/orders/quote` | student | `{restaurantId, lines: [{itemId, qty}], mode}` → `{lines, subtotal, deliveryFee, total, errors?}`. Lets the cart show server prices. |
| POST `/orders` 🔁 | student | `{restaurantId, lines, mode, address?, note?, paymentMethod: 'wave'\|'orange_money'}` → 201 `{order, payment: {reference, checkoutUrl, expiresAt}}`. **Client prices are ignored.** Rejects closed / paused restaurants, unavailable items, and delivery when `deliveryFee === null`. |
| GET `/orders?cursor` | student (own) | |
| GET `/orders/{id}` | student (own) | Status with step labels (`orderSteps`). 404 for other users. |
| POST `/orders/{id}/cancel` | student (own) | Only in `pending_payment` (Q-10) |
| GET `/org/{orgId}/orders?status=` | org:owner,manager,staff | Restaurant queue |
| POST `/org/{orgId}/orders/{id}/transition` | org:owner,manager,staff | `{to: 'preparing'\|'ready'\|'done'\|'rejected', reason?}`. Validated against the state machine. `rejected` triggers a refund. |
| CRUD `/org/{orgId}/restaurants/{id}/items` · PATCH `/org/{orgId}/restaurants/{id}` | org:owner,manager | Hours, delivery fee, `acceptingOrders`, availability toggles |

## Payments — `payments`

| Method & path | Guard | Notes |
|---|---|---|
| GET `/payments/{reference}` | user (own) | `{reference, status, amount, provider, purpose, purposeRef, checkoutUrl?, expiresAt}`. The app polls this after returning from checkout. |
| POST `/payments/{reference}/checkout` | user (own) | Opens a new checkout session for a `pending` payment whose session expired (same reference) |
| POST `/payments/webhooks/wave` | public + **signature** | Raw body is kept to verify the HMAC. Always 200 once stored (also for duplicates). 401 on a bad signature. |
| POST `/payments/webhooks/orange-money` | public + **notif_token verification** | |
| POST `/payments/webhooks/simulated` | public + HMAC | **Only mounted when the simulator is enabled** |
| GET `/dev/payment-simulator/{reference}` | public, **non-production only** | HTML page: amount, purpose, buttons *Payer* / *Échec* / *Annuler* / *Payer en retard* / *Envoyer le webhook 2×* |
| POST `/dev/payment-simulator/{reference}/{action}` | same | Fires a **signed webhook** to our own webhook endpoint, through the exact production code path |
| GET `/admin/payments?status=&provider=` · GET `/admin/refunds?status=` · POST `/admin/refunds/{id}/mark-paid-manually` | platform:finance | Reconciliation |

## Caravans — `caravans` (student side)

> **Implemented 2026-10-31**, with tickets in a generic `ticketing` module (09-decisions.md, "Caravans and generic ticketing"). Contract in Swagger, tags `caravans`, `tickets`, `organizer`. Tickets: `GET /tickets`, `GET /tickets/{id}`, `POST /tickets/{id}/cancel`, `POST /tickets/{id}/transfers`, `GET /ticket-transfers?direction=`, `POST /ticket-transfers/{id}/accept|decline|cancel`. Scanning: `POST /org/{orgId}/admissions` (`qr` | `code` | `ticketId`), `…/admissions/batch`, `POST /org/{orgId}/tickets/{ticketId}/admission/void`.

| Method & path | Guard | Notes |
|---|---|---|
| GET `/caravans/departures?direction=&from=&to=&dateFrom=&cursor` | user | `[{id, code, organizer: {id, name, kind, level, rating, trips}, vehicle: {label}, direction, from, to, departureAt, pickups, dropoffs, price, seatsFree, totalSeats, minPassengers, confirmBy, confirmed, missing}]` (plate hidden until booked) |
| GET `/caravans/departures/{id}` | user | Plus `myTicketId?` |
| GET `/caravans/departures/{id}/seats` | user | `{layout: {rows, seatsPerRow, windowSeats, blocked}, taken: int[], suggested: int}`. Who sits where is never exposed. |
| POST `/caravans/departures/{id}/bookings` 🔁 | student | `{seat: int \| 'auto', pickupStopId, dropoffStopId, paymentMethod}` → 201 `{booking: {id, seat, status: 'held', holdExpiresAt}, payment: {reference, checkoutUrl}}`. Errors: `SEAT_TAKEN`, `NO_SEATS_LEFT`, `ALREADY_BOOKED` (incl. transferred), `BOOKING_CLOSED`, `INVALID_STOPS`. |
| DELETE `/caravans/bookings/{id}` | student (own) | Releases a `held` booking (back button / abandon) |
| GET `/caravans/bookings/{id}` | student (own) | Status while paying |
| GET `/caravans/tickets?status=` | student (own as holder) | "Mes billets" |
| GET `/caravans/tickets/{id}` | holder | `{id, code, seat, pickup, dropoff, departure summary, status, qr: string, cancellation: {allowed, fee, refundAmount, freeUntil}, transfer?: {pending, to: phoneMasked}}`. **`qr` is the signed token.** |
| POST `/caravans/tickets/{id}/cancel` 🔁 | holder | Server computes the fee (≥ 24 h → 0, else 10 %, refused after departure or once boarded). → `{refundAmount, fee, refundStatus}` |
| POST `/caravans/tickets/{id}/transfers` 🔁 | holder | `{recipientPhone}` → 201 `{transferId, status: 'pending', expiresAt}`. Validation: the recipient exists, is a student, isn't yourself, and has no ticket for this departure. Not after the transfer cutoff (Q-4). |
| GET `/caravans/transfers?direction=incoming\|outgoing` | student | |
| POST `/caravans/transfers/{id}/accept` · `/decline` | recipient | Accept: holder changes and `version++` (old QR invalid) |
| POST `/caravans/transfers/{id}/cancel` | sender | |

## Organizer space — `organizations`, `caravans`

> **Implemented 2026-10-31**, with tickets in a generic `ticketing` module (09-decisions.md, "Caravans and generic ticketing"). Contract in Swagger, tags `caravans`, `tickets`, `organizer`. Tickets: `GET /tickets`, `GET /tickets/{id}`, `POST /tickets/{id}/cancel`, `POST /tickets/{id}/transfers`, `GET /ticket-transfers?direction=`, `POST /ticket-transfers/{id}/accept|decline|cancel`. Scanning: `POST /org/{orgId}/admissions` (`qr` | `code` | `ticketId`), `…/admissions/batch`, `POST /org/{orgId}/tickets/{ticketId}/admission/void`.

All of these routes are under `/org/{orgId}/…` and require an active membership. **The departure must belong to `orgId`**; otherwise the response is 404.

| Method & path | Guard | Notes |
|---|---|---|
| GET `/org/{orgId}` | org:any | Organization card (category, email, logoUrl…) + my roles |
| PATCH `/org/{orgId}` | org:owner | `{email}` (logo with the media module) |
| GET `/org/{orgId}/departures?status=&cursor` | org:any | "Mes activités": counts booked / boarded |
| GET `/org/{orgId}/departures/{id}/manifest` | org:owner,manager,scanner | Passengers grouped by stop: `[{stop, boarding: [{ticketCode, seat, firstName, lastInitial, phone?, boarded, dropoff}], alighting: [...]}]`, plus `counts: {booked, onBoard}` and `optional` per stop (nobody on or off). Phone exposure: Q-16. |
| POST `/org/{orgId}/boardings` | org:owner,manager,scanner | `{qr? \| code?, departureId?, stopId?, clientScanId, scannedAt, deviceId}` → `{result: 'boarded'\|'duplicate'\|'rejected', tone, reason?, passenger?: {firstName, lastInitial, seat, pickup, dropoff}, departureId, atDifferentStop?: boolean}`. The scanner tab works without picking a departure: the server resolves it across the org's departures of the day. A typed `code` needs `departureId`, or matches today's departures only. |
| POST `/org/{orgId}/boardings/batch` | same | Up to 200 offline scans, idempotent by `clientScanId`, returns per-item results (Q-17) |
| POST `/org/{orgId}/boardings/{id}/void` | org:owner,manager | "Unboard". Audited, with a reason. |
| POST `/org/{orgId}/departures/{id}/stops/{stopId}/leave` | org:owner,manager,scanner | "Le bus repart de cet arrêt" |
| GET `/org/{orgId}/departures/{id}/offline-pack` | org:scanner+ | Manifest + public key IDs for offline verification |
| POST `/org/{orgId}/departures` · PATCH `…/{id}` · POST `…/{id}/publish` · POST `…/{id}/cancel` | org:owner,manager | **No UI in the app** (web platform). Cancelling refunds everyone at 100 %. Price, stops and seats are locked once there are bookings. |
| CRUD `/org/{orgId}/vehicles` | org:owner | Capacity verified by an admin |
| GET/POST/DELETE `/org/{orgId}/members` | org:owner | Team. API only; the in-app "Mon équipe" stays a placeholder. |
| POST `/admin/organizations` · PATCH `/admin/organizations/{id}` (level, status) · POST `/admin/organizations/{id}/members` | platform:admin | Onboarding while the web platform doesn't exist |

## Sunu Taxi — `taxi`

> **Implemented 2026-10-31.** The exact contract is in Swagger (`/docs`, tag `taxi`); the rules that changed from this draft are in 09-decisions.md ("Sunu Taxi and the payments core"). Hand-over is immediate (no accept step), the claim is `POST /taxi/trips/{id}/claim {method}`, and `POST /taxi/trips` also accepts `leaveInMinutes`.

| Method & path | Guard | Notes |
|---|---|---|
| GET `/taxi/trips?cursor` | student | Open trips not departed (up to 15 min after their time): `{id, organizer: {firstName, initials, trips, lateCancels}, from, to, departureAt, seats, seatsTaken, seatPrice, fare, locked, me: {role?, status?}}` |
| GET `/taxi/trips/{id}` | student | Passenger list (first names + initials), checked-in flags, vehicle (participants only), rules |
| GET `/taxi/me` | student | `{activeTrip?, strikes30d, limit: 3, suspendedUntil?}` |
| POST `/taxi/trips` 🔁 | student | `{from, to, departureAt, seats, fare}` → the server computes `seatPrice`. Rejects if suspended or already in an active trip. |
| POST `/taxi/trips/{id}/join` 🔁 | student | `{paymentMethod}` → `{participant: {status: 'pending_payment', expiresAt}, payment: {reference, checkoutUrl}}`. The seat is held for 10 min. |
| POST `/taxi/trips/{id}/leave` | participant | Refund if `now < lockAt`, else none (rule shown in the response before confirming: `GET …/leave-quote`) |
| POST `/taxi/trips/{id}/cancel` | trip organizer | Refunds everyone at 100 %. A **strike** if `now ≥ lockAt` and paid passengers > 0. |
| POST `/taxi/trips/{id}/handover` | trip organizer | Offers the trip to the earliest-joined passenger → `pending` |
| POST `/taxi/trips/{id}/handover/accept` · `/decline` | that passenger | Accept: roles swap, no strike. The old organizer becomes a passenger? Or leaves? (Q-8) |
| POST `/taxi/trips/{id}/check-in` | participant | Once (idempotent). Posts a system line "X est là ✓". |
| PUT `/taxi/trips/{id}/vehicle` | trip organizer | `{model, color, plate}`, posts a pin message |
| POST `/taxi/trips/{id}/depart` | trip organizer | Only from `lockAt − 15 min`? (Q-8). Creates the payout `(paid passengers) × seatPrice`. |

## Lost & found — `lostfound`

| Method & path | Guard | Notes |
|---|---|---|
| GET `/lost-found/items?status=&category=&q=&cursor` | student | Public DTO: `{id, status, category, kind, name, details, where, spot, occurredAt, holder, photo, by: 'Moussa S.', ownerHint?, ownerNotified, returned, mine}` |
| GET `/lost-found/items/{id}` | student | Plus `secret` **only if you are the reporter**, plus `myClaim?` |
| POST `/lost-found/items` | student | `{status, categoryId, name, details?, secret?, where, spot?, occurredAt, holder?, photoMediaId?}`. Validation: no photo for cards; a photo is required for a found object. Rate limit 10/day. |
| DELETE `/lost-found/items/{id}` | reporter | Soft-close |
| POST `/lost-found/card-scans` | student | `{cardNumber, where}` → `{matched: boolean, ownerHint?: 'Awa D.' (Q-7), itemId}`. Creates the found-card item and notifies the owner ("Ta carte étudiant a été trouvée"). Rate limit 5/h, 15/day per user; enumeration alerts. |
| POST `/lost-found/items/{id}/claims` | student (not the reporter) | `{proof}` (→ encrypted) → `{claimId, conversationId}`. "C'est à moi" on found items. |
| POST `/lost-found/items/{id}/found-reports` | student (not the reporter) | "Je l'ai trouvé" on lost items → conversation with the owner |
| GET `/lost-found/items/{id}/claims` | reporter | Lists claims **with the decrypted proof**, so the reporter can compare it with their secret |
| POST `/lost-found/claims/{id}/accept` · `/reject` | reporter | Accept → item `claimed` |
| POST `/lost-found/items/{id}/returned` | reporter or accepted claimant (Q) | Closes the item and its conversations |
| POST `/lost-found/items/{id}/reports` | student | Moderation: auto-hide at N reports |
| GET `/lost-found/office` | user | Office details |
| GET/PATCH `/admin/lost-found/items` | platform:lost_office | Items held at the office; hand-over to the owner after an ID check |

## Messaging — `messaging`

> **Implemented 2026-10-31** as a generic module for every feature with a chat (09-decisions.md, "Chat: one messaging module"). Contract in Swagger, tag `messaging`. Also: `GET /conversations/{id}` (members, `canWrite`, `blockedKeys`, `unread`), `GET /conversations?type=` (my conversations with unread counts), `POST …/messages/{messageId}/report`, `POST …/messages/{messageId}/block-author`, `GET /admin/message-reports`. Messages are returned oldest first; `?after=` fills a gap after a reconnection.

| Method & path | Guard | Notes |
|---|---|---|
| GET `/conversations/{id}/messages?before=&limit` | policy.canRead | Newest first. Messages from blocked users are filtered out for the viewer. |
| POST `/conversations/{id}/messages` | policy.canWrite | `{body, kind: 'text'\|'quick_reply', clientMessageId}`. Taxi: paid participants until `chatClosesAt`. Lost: the claim's two parties until the item is closed. |
| POST `/conversations/{id}/read` | participant | `{lastReadMessageId}` |
| GET `/conversations/unread` | user | Counts per conversation |

## Notifications — `notifications`

| Method & path | Guard | Notes |
|---|---|---|
| GET `/notifications?category=social\|cours\|paiements&cursor` | user (own) | `{id, title, body, category, icon, tone, deepLink, createdAt, read}` |
| GET `/notifications/unread-count` | user | |
| POST `/notifications/read` | user | `{ids?: string[], all?: true}` |
| POST `/admin/broadcasts` | platform:content_editor | `{audience, title, body, category, deepLink}` → 202, fanned out by a job |

## Courses & scholarships

| Method & path | Guard | Notes |
|---|---|---|
| GET `/me/timetable?weekStart=YYYY-MM-DD` | student | `{days: [{date, entries: [{id, start, end, title, room, teacher, kind, moved?: {from}}]}]}` |
| POST `/admin/timetable/import` | platform:academic_editor | CSV (dry run first) |
| PATCH `/admin/timetable/entries/{id}` | platform:academic_editor | A move or cancellation notifies the group (category `cours`) |
| GET `/scholarships/next-payment` | student | `{date, methods, label} \| null` |
| CRUD `/admin/scholarships/schedules` | platform:finance | |

## Media — `media`

| Method & path | Guard | Notes |
|---|---|---|
| POST `/media` | user | multipart `file` + `purpose`. Accepts JPEG/PNG/WebP/HEIC ≤ 8 MB, checked by **magic bytes**, not by extension. Processed by sharp: rotated, **EXIF stripped**, ≤ 1600 px, WebP. → `{mediaId, url}`. 20 per day per user. |

## Real-time — `/ws`

- **Connection:** `wss://…/ws`. The first frame must be `{type: 'auth', accessToken}` within 5 s, otherwise the socket closes with code 4401. The token is re-validated on refresh (`{type: 'auth'}` again).
- **Subscribe:** `{type: 'sub', topic: 'conversation:<id>' | 'taxi:<id>' | 'order:<id>' | 'departure:<id>' | 'me'}`. Every subscription is authorized by the owning module's policy; a denial returns `{type: 'error', code: 'FORBIDDEN'}`.
- **Server events:** `message.created`, `taxi.updated`, `order.status`, `boarding.updated`, `notification.created`, `payment.updated`.
- **Sending messages goes through REST.** It's simpler to validate, rate-limit and make idempotent. WebSocket is server→client only.
