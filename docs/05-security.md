# 05 — Authentication, authorization and security strategy

## 1. Authentication

### 1.1 Passwords
- **Argon2id**, starting at `memoryCost 19 MiB, timeCost 2, parallelism 1` (the OWASP minimum), tuned to about 100 ms on the production CPU. Parameters are stored in the hash string, so they can be upgraded transparently: on a successful login, if the parameters are outdated, the password is re-hashed.
- Policy, following the frontend: ≥ 8 characters with ≥ 1 digit. The server adds a maximum of 128 characters and rejects the 10 k most common passwords.

### 1.2 OTP
- A cryptographically random code. **Length 4** to match `OTP_LENGTH`, but we **recommend 6** (Q-14); the length is a config value returned by the API.
- Stored as `HMAC-SHA256(code, OTP_PEPPER)` and compared in constant time.
- TTL 5 min, 5 attempts, then `locked`. Resend after 60 s, at most 3 sends per challenge.
- Per-phone and per-IP limits:
  - 5 challenges per phone per day
  - 20 per IP per hour
  - only **+221** mobile prefixes (70/71/75/76/77/78)

  This also blocks **SMS-pumping fraud**, where attackers trigger SMS to premium numbers.
- A successful verification yields a `verificationToken`: a JWT bound to `{phone, purpose, challengeId}`, valid 15 min and **single use** (the challenge moves to `verified` and the token's `jti` is consumed).
- **Dev mode:** `OTP_DEV_MODE=true` uses the fixed code `1234` (= `DEV_OTP`) and logs it, without sending an SMS. The app **refuses to boot** with this flag when `NODE_ENV=production`.

### 1.3 Tokens and sessions
- **Access token:** a JWT signed with **EdDSA (Ed25519)**, 15 min. Claims: `sub`, `sid` (session ID), `pr` (platform roles), `iat`, `exp`, `kid`. Organization memberships are **not** put in the token; they are read per request through a 60 s Redis cache, invalidated on change. Removing someone from a team therefore takes effect immediately.
- **Refresh token:** 256-bit random and opaque, stored on the device in `expo-secure-store`. On the server, only its SHA-256 is stored.
  - **Rotation:** every `/auth/refresh` call revokes the old token and returns a new one.
  - **Reuse detection:** if a `rotated` token is presented, the whole family is revoked and the event is audited.
  - **Expiry:** sliding 30 days, absolute 90 days.
- **Revocation:** logout, logout-all, password change or reset, account suspension, or an admin action marks the sessions `revoked` and writes `sid` to a Redis denylist with a TTL of 15 min. The auth plugin checks that denylist, so revocation takes effect within one request rather than when the token expires.

### 1.4 Login protection
- **Same answer for every failure:** "Identifiants incorrects", so the response never reveals whether an account exists. Comparable timing is guaranteed by hashing against a dummy hash when the user is unknown.
- **Progressive lockout per account:**
  - after 5 failures: a 1 min lock
  - then 5, 15 and 60 min
  - the counter resets on success
  - each lock notifies the user by SMS (or push)
- **Per IP:** 30 attempts per 10 min. **Per identifier:** 10 per 10 min.

### 1.5 Demo accounts
- Created **only** by `scripts/seed` (which refuses `NODE_ENV=production`) with the same phones as the frontend (`770000001`, `770000002`) and a documented dev password.
- There is no special login code path: demo accounts are ordinary accounts in the dev database.

## 2. Authorization

The layers are evaluated in order, and **all of them run on the server**:

1. **Authentication guard** (route level): `user`, `student`, `org:<roles>` or `platform:<role>`.
2. **Capability:**
   - `student` = a `studentProfiles` document exists.
   - `organizer` = at least one active membership.

   `GET /me.spaces` is derived from these. The frontend's `space` value is never trusted.
3. **Organization role:** `owner` (everything, including team and payouts), `manager` (departures, menus, orders), `scanner` (boarding and manifest only), `staff` (restaurant orders). **Never granted automatically.** An admin grants `owner`; owners grant the other roles.
4. **Resource ownership** (in services, which defends against **IDOR**). Every query for a user-owned resource includes the owner in the filter: `findOne({_id, userId: actor.id})`. A miss returns **404** (no existence oracle). Examples:
   - orders: `userId`
   - tickets: `holderUserId`
   - departures: `orgId` from the path, plus a membership check
   - taxi actions: participant or organizer role
   - lost item secret and claims: reporter only
   - conversations: the policy
5. **State and time rules:** for example, cancel only before departure, chat only until `chatClosesAt`, scan only for departures of the actor's organization.

Every admin route requires a platform role. All admin and organizer mutations are audited.

## 3. Threats and controls

| Threat | Control |
|---|---|
| NoSQL injection (`{"$gt": ""}`) | TypeBox schemas with exact types and `additionalProperties: false`. Strings stay strings. Repositories build queries from typed values only. No `$where` or `$function`. Free-text search uses `$text` with an escaped string. |
| IDOR | Owner-scoped queries (above). Tests for every resource type. |
| Brute force / credential stuffing | Rate limits (Redis, per IP and per identifier), progressive lockout, Argon2. |
| Account enumeration | Login and password reset say when a number has no account (09-decisions.md), since the register check reveals it anyway. The register check is rate-limited (an accepted trade-off). |
| Forged or reused tickets | Ed25519-signed QR, `version` check, unique active boarding, scanning by org scanners only, departure ownership check. |
| Payment fraud | Payment state only changes after **verified webhooks** or a **server-side status query** to the provider. The amount and currency are checked against the stored payment. No client "success" flag exists in the API. |
| Webhook spoofing / replay | HMAC signature with timestamp tolerance (±5 min) for Wave and the simulator. Notification-token check plus a status re-query for Orange Money. Unique event IDs. |
| Price manipulation | Prices are always read from the database (`menuItems.price`, `departures.price`, taxi `seatPrice`). Client amounts are ignored. |
| Race conditions | Partial unique indexes, conditional state transitions, transactions (`03-database.md` §5). |
| Upload attacks | Magic-byte sniffing, size limits, re-encoding with sharp (which drops polyglot payloads), EXIF/GPS stripping, random storage keys. Private buckets for anything non-public (signed URLs, 10 min). Never served from the API origin. |
| XSS through user content (admin web later) | Store raw text, escape on render. The HTML of the payment simulator is server-rendered with escaped values. |
| Sensitive data exposure | DTO allowlists, never `toJSON` of documents. Pino redaction. Masked phones (`77 ••• •• 28`). Field encryption (AES-256-GCM, key ring) for lost-item secrets, claim proofs and payout accounts. HMAC hashing for card numbers. |
| Secrets | Environment / secret manager. Key IDs for JWT, QR, field-encryption and webhook keys allow rotation without downtime. `.env` stays out of git; `.env.example` holds placeholders. |
| Transport | HTTPS only (HSTS at the proxy). WebSocket over WSS. `trustProxy` configured for the correct client IP. |
| Abuse in chats | Blocking, reporting, rate limits (20 messages/min), a 1000-character limit. Phone numbers in messages are flagged by a soft filter (the safety tip says not to share numbers). |
| Headers / CORS | `@fastify/helmet`. CORS is closed by default; the mobile app doesn't need it. Opened only for a future admin web origin. |

## 4. Audit log (sensitive actions)

Audited actions:

- logins and failures that cause a lockout
- password reset or change, session reuse detection
- role and membership grants and revocations
- organization level changes
- departure create / publish / cancel
- ticket cancel and transfer
- boarding and void
- payment status changes, refunds, manual refund marks, payouts
- lost-item claim decisions, card scans (matched or not), moderation hides
- announcement publishing
- admin edits of student profiles

Each entry records the actor, the target, the `requestId`, the IP and minimal metadata, **never secrets or OTP codes**.

## 5. Privacy

Senegalese Law 2008-12 applies, overseen by the **CDP**, Senegal's personal data protection authority. A declaration is probably required before launch (Q-20).

- **Data minimization:**
  - Other students see a first name and last-name initial only.
  - Organizers see the manifest only for their own departures, and only until 48 h after arrival.
- **Retention:** see Q-20 for the proposed defaults.
- **Account deletion:** soft-deleted, then anonymized after 30 days. Financial records are kept as legally required, under the pseudonymous user ID.
