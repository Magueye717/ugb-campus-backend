# UGB Campus — Backend

The backend for the UGB Campus mobile app (`../ugb-campus`): a **modular monolith** built with Node 22 LTS, TypeScript, Fastify 5, MongoDB (replica set), Redis and BullMQ.

> **Status: architecture approved. Implementation in progress (Phase 5: infrastructure, Phase 6: auth/accounts).**

## Documentation

| # | Document | Covers (spec §17 deliverables) |
|---|---|---|
| 01 | [Frontend discovery](docs/01-frontend-discovery.md) | 1 · understanding of the app, 2 · frontend→backend map, simulated rules, placeholders |
| 02 | [Architecture](docs/02-architecture.md) | 3 · modular monolith, 4 · folder structure, 5 · modules and dependencies, 18 · scalability, 19 · Docker |
| 03 | [Database](docs/03-database.md) | 6 · collections and schemas, 7 · relationship diagram, 8 · indexes, consistency, state machines |
| 04 | [API](docs/04-api.md) | 9 · endpoints, DTOs, permissions, errors, WebSocket protocol |
| 05 | [Security](docs/05-security.md) | 10 · authentication and authorization, 17 · security strategy, privacy |
| 06 | [Domain designs](docs/06-domain-designs.md) | 11 · payments (+ simulator), 12 · caravans, 13 · Sunu Taxi, 14 · lost & found privacy, 15 · notifications and jobs, 16 · real-time |
| 07 | [Testing and observability](docs/07-testing-observability.md) | 20 · testing strategy, observability |
| 08 | [Risks and questions](docs/08-risks-and-questions.md) | 21 · risks, open business questions with defaults |
| 09 | [Decision log](docs/09-decisions.md) | answers to the questions; **overrides earlier docs** |

## Implementation status

| Step | Scope | Status |
|---|---|---|
| 1 | Infrastructure: Fastify, config, MongoDB replica set, Redis, BullMQ, errors (problem+json), logging, health, OpenAPI, Docker, migrations, seed | ✅ done, tested |
| 2 | **identity + accounts + organizations** (incl. user e-mail, location, avatar field; organization category, e-mail, logo field): sign-up (OTP), login, refresh rotation, logout, password reset/change, `/me` and spaces, org roles, admin onboarding API | ✅ done |
| 3 | notifications + content + media: inbox, push, `/home`, uploads | next |
| 4 | payments: webhook inbox, purpose handlers, **simulated provider**, payouts (refunds + organizer claims), reconciliation | |
| 5 | food: restaurants, Resto U menus and stock, orders | |
| 6 | caravans: departures, seat holds, tickets, QR, cancellation, transfer, manifest, boarding, claims | |
| 7 | taxi + messaging + real-time | |
| 8 | lostfound | |
| 9 | places, academics, scholarships | |
| 10 | frontend integration (UI unchanged), then hardening (security review, k6), then deployment readiness | |

Each step ships with its tests. The seed data mirrors `ugb-campus/constants/data.ts`.

## Run it locally

Requirements: Node ≥ 22.12, Docker, and Redis on `localhost:6379` (or add `--profile redis` below).

```bash
cp .env.example .env               # then: npm run keys >> .env  (and set OTP_PEPPER to a random string)
docker compose up -d mongo         # MongoDB 8 replica set "rs0" on localhost:27018
npm ci
npm run migrate                    # collections, validators, indexes (idempotent)
npm run seed                       # demo organizations and accounts (refuses production)
npm run dev                        # API on http://localhost:3000, Swagger UI (back office) on /docs
npm run dev:worker                 # BullMQ workers (OTP delivery: logged to the console in development)
```

> **Why 27018?** The MongoDB on 27017 on this machine is a standalone instance (no replica set, so no transactions) that holds other projects' data. The project runs its own replica set instead (see `docs/09-decisions.md`).

### Demo accounts (development only)

Password: **`Campus2026`** for every account. OTP code in development: **`1234`**.

| Phone | Who | Spaces |
|---|---|---|
| 77 000 00 02 | Awa Diop, student P232055, owner of *Amicale de Ziguinchor* | student + organizer |
| 77 000 00 01 | Modou Khoulé, owner of *Khoulé & Frère* | organizer |
| 77 000 00 03 | Cheikh Fall, scanner at *Khoulé & Frère* | organizer |
| 77 123 45 67 | Moussa Sow, student P210001 (the app's "Ce compte existe déjà" test number) | student |
| 78 111 22 33 / 76 123 45 00 | Fatou Ndiaye / Ibrahima Diallo, students | student |
| 77 000 00 99 | Admin Campus, platform admin (Swagger back office) | — |

### Quality gates

```bash
npm run typecheck && npm run lint && npm test   # tests need the compose MongoDB (27018) and Redis
docker build -t ugb-campus-backend .            # multi-stage, non-root runtime image
```

ESLint enforces the module boundaries: a module imports another module only through its `index.ts`, and `platform/` never imports a module.
