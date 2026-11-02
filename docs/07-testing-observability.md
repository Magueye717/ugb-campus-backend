# 07 — Testing, reliability and observability

## 1. Test pyramid

| Level | Tooling | Scope |
|---|---|---|
| Unit | Vitest, fake `Clock` | Pure rules: cancellation fee, seat price, auto-seat order, state machines, QR sign/verify, OTP hashing, open/closed hours (Dakar), DTO mappers |
| Integration (DB) | Vitest + `MongoMemoryReplSet` (real transactions and partial indexes) + Redis in Docker | Repositories, services, transactions, indexes, sweepers |
| API | `app.inject()` against the full app | Validation, status codes, problem+json, guards, IDOR, idempotency replay |
| Concurrency | `Promise.all` bursts against the integration stack, plus 2 Fastify instances and 2 workers in one test process sharing Mongo and Redis | Races on seats, taxis, boarding, webhooks, jobs |
| Contract | OpenAPI snapshot diffed in CI | Accidental breaking changes for the app |
| Load (Phase 9) | k6 | Caravan sale rush, lunch menu peak, broadcast |

**Coverage gate:** 90 % lines on `service.ts` and `policies.ts`, 80 % overall. **A module is not complete until its suite passes in CI.**

## 2. Mandatory scenarios (from the spec)

| # | Scenario | Expected result |
|---|---|---|
| 1 | 50 students book seat 12 of the same departure at once; 50 students use `seat: 'auto'` at once on 30 free seats | Exactly 1 success for seat 12, 49 × `SEAT_TAKEN`. Auto: 30 successes, 20 × `NO_SEATS_LEFT`, no seat assigned twice, `seatsTaken` equals the actual active bookings. |
| 2 | The same signed webhook is delivered twice, and twice concurrently | One `succeeded` transition, one ticket, one notification. The second delivery returns 200 with no side effect. |
| 3 | Payment succeeds after the hold expired: (a) seat still free, (b) seat taken by someone else | (a) confirmed with the same seat; (b) payment `unfulfillable`, refund created, the other student keeps the seat. |
| 4 | The same ticket is scanned twice; concurrently on 2 devices; offline batch replayed | One active boarding. The others are stored as `duplicate`, and the response says "Déjà à bord". |
| 5 | User B requests user A's order, ticket, booking or payment | 404, nothing leaked. |
| 6 | A non-participant, or a participant in `pending_payment`, reads or writes the taxi chat over REST or WebSocket | 404/403 over REST, `FORBIDDEN` over WebSocket. Writing after `chatClosesAt` → 422. |
| 7 | A student claims someone else's item; tries to read `secret`; claims twice; accepts their own claim | No transfer without the reporter accepting; `secret` absent; `409`; `403`. |
| 8 | An organizer of org X reads the manifest, scans, or cancels a departure of org Y; a `scanner` tries to cancel | 404 / 403. Audited attempt. |
| 9 | Expo push returns 500, then times out, then succeeds | Retried with backoff, delivered once, inbox entry created once. `DeviceNotRegistered` disables the token. |
| 10 | Two workers start the same repeatable sweeper; a job stalls and is reprocessed | No duplicate effects (holds expired once, refunds created once, notifications deduplicated). |

**Also covered:**

- OTP: expiry, 5 attempts → locked, resend throttle, single-use verification token.
- Refresh-token reuse revokes the family. A revoked session's access token is rejected within one request.
- Login lockout progression, and the generic error for an unknown user.
- Cancellation fee at exactly 24 h, 24 h − 1 s, and after departure.
- Transfer: concurrent accept vs cancel; transfer during a pending transfer; the old QR is rejected after a transfer.
- Taxi:
  - the 30-min lock boundary
  - the strike at a late cancel only with paid passengers
  - suspension at 3 strikes
  - one active trip, including two concurrent joins by the same user on 2 trips
  - overbooking the last seat
- Order totals ignore client prices; delivery is refused when `deliveryFee` is null; ordering from a closed restaurant is refused.
- Uploads: wrong magic bytes, oversized files, EXIF removed, card photo refused.
- Minimum passengers not reached at `confirmBy` → everyone refunded once.
- Production boot refuses the simulator, the dev OTP and seeding.

## 3. Observability

- **Logs:** pino JSON, one line per request (method, route pattern, status, duration, `requestId`, `userId`). The `requestId` comes from `X-Request-Id`, or is generated, and is echoed back. The `correlationId` is propagated into job data, so the logs of a webhook → job → notification chain can be joined. Sensitive fields are redacted (see `02-architecture.md` §7).
- **Metrics** (Prometheus `/metrics`, internal network only):
  - HTTP RED metrics per route
  - Mongo pool usage and command latency
  - Redis latency
  - BullMQ depth, active, failed and age per queue
  - business counters: bookings held/confirmed/expired, `SEAT_TAKEN` rate, payments by status, webhook signature failures, refunds `manual_required`, OTP sends, push failures, WebSocket connections
- **Errors:** Sentry (optional DSN), with PII scrubbing. Only 5xx and unexpected errors are reported, not 4xx.
- **Health:** `/health/live` and `/health/ready` (Mongo, Redis, migrations).
- **External calls:** each one has a timeout (payment providers 10 s, SMS 5 s, Expo 10 s), retries in jobs only (never in the HTTP path), and a circuit breaker on payment providers. When the breaker is open, checkout returns `503 PAYMENT_PROVIDER_UNAVAILABLE`.
- **Alerts** (suggested):
  - 5xx > 1 % over 5 min
  - webhook signature failures > 0
  - payments `pending` older than 30 min
  - refunds `manual_required` > 0
  - queue age > 2 min
  - Mongo replication lag
