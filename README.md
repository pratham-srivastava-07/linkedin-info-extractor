# ProfileLens

A hosted API that takes a public LinkedIn profile URL and returns a clean, stable
JSON representation of that profile — name, headline, location, about, experience,
education, skills, certifications, languages and profile image.

Upstream returns deeply nested, inconsistent, versioned JSON. ProfileLens's job is
to absorb that and hand downstream consumers (CRM enrichment, recruiting tools,
lead scoring) one predictable schema that does not move when upstream does.

## How it works

Extraction is **purely reverse-engineered HTTPS — there is no browser anywhere in
the request path.** No Playwright, no headless Chromium, no automation driver. A
request is validated, checked against a Postgres cache, put through an in-process
serial queue, and then answered with a single `GET
/voyager/api/identity/profiles/{publicId}/profileView` call to LinkedIn's internal
Voyager API, carrying the operator's own `li_at` / `JSESSIONID` cookies plus a
derived `csrf-token`. The raw response goes through a pure normalization layer and
comes back as the published schema. That constraint is the defining property of
this system: it is why the service deploys onto a plain Node image, why Postgres is
the only stateful dependency, and why `src/linkedin/` must never grow a browser
dependency.

Postgres holds three things: the profile cache, an audit row per extraction, and
session *validation state* (a SHA-256 fingerprint of the cookie and when it was
last proven to work). Cookies themselves are never stored — they arrive from the
environment on every boot.

See [`docs/architecture.md`](docs/architecture.md) for the full component
breakdown.

## Repo map

| Path | What's in it |
|---|---|
| `backend/` | The API. Express 5 + TypeScript, Prisma 6, Zod 4, Vitest. See [`backend/README.md`](backend/README.md). |
| `frontend/` | Next.js 16 + React 19 + Tailwind 4 internal test harness. Currently still the default `create-next-app` scaffold — the harness UI has not been built yet. |
| `docs/` | The contract and the reasoning: [`api.md`](docs/api.md), [`architecture.md`](docs/architecture.md), [`frontend.md`](docs/frontend.md), [`notes.md`](docs/notes.md). |
| `infra/` | [`docker-compose.yml`](infra/docker-compose.yml) — a local Postgres 16 (role `user`, database `profilelens`) with a `pg_isready` healthcheck. Nothing else; there is no Redis and no browser image. |

`CLAUDE.md` at the root states the product intent; `backend/CLAUDE.md` states the
layering rules the backend code follows.

## Quickstart

Requires Node (this repo is developed on v23 — see `.nvmrc`) and Docker.

**1. Start Postgres.**

```bash
docker compose -f infra/docker-compose.yml up -d
```

The container is named `linkedin-api` and publishes `5432`. It reports healthy via
`pg_isready` once it is actually accepting connections.

**2. Configure the backend.**

```bash
cd backend
npm install
cp .env.example .env
```

Then edit `backend/.env`:

- `DATABASE_URL` — `infra/docker-compose.yml` provisions role `user` / password
  `password` / database `profilelens`, which is exactly what `.env.example`
  already ships:
  `postgresql://user:password@localhost:5432/profilelens?schema=public`.
  One caveat worth knowing: Postgres only applies `POSTGRES_USER`/`POSTGRES_DB`
  when it initialises an *empty* data directory, so a `postgres-data` volume left
  over from an earlier stack keeps whatever role and database it was created
  with. If connections are refused, check what the volume actually has with
  `docker exec linkedin-api psql -U user -l`, or start clean with
  `docker compose -f infra/docker-compose.yml down -v`.
- `API_KEY` — any string. Callers send it as `Authorization: Bearer <API_KEY>`.
- `PORT` — defaults to **4000**. The frontend's `next dev` takes 3000, so the two
  halves of the repo run side by side without a collision.
- `CORS_ORIGINS` — comma-separated browser origins allowed to call the API, or `*`
  (the default) for any.
- `LINKEDIN_LI_AT` and `LINKEDIN_JSESSIONID` — your own cookies, copied from a
  logged-in browser (DevTools → Application → Cookies → `https://www.linkedin.com`).
  Keep `JSESSIONID` exactly as shown, quotes included.

**Both cookie values must be non-empty.** `src/config/env.ts` validates the
environment on import, so the process exits at boot with a Zod error if either is
blank — it does not start and then fail requests.

**3. Apply migrations and run.**

```bash
npx prisma migrate deploy
npm run dev          # http://localhost:4000
```

**4. Check it's alive.**

```bash
curl http://localhost:4000/health
```

`{"status":"ok","database":"connected","session":"valid"}` means both Postgres and
the cookies are good. `"session":"invalid"` with HTTP 503 means the cookies were
rejected upstream — the endpoint deliberately fails readiness so a platform health
check takes a dead instance out of rotation.

**5. Extract a profile.**

```bash
curl -X POST http://localhost:4000/profile \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.linkedin.com/in/example-profile/"}'
```

> **Not yet proven live.** A successful extraction needs a real, non-empty
> `LINKEDIN_LI_AT`. No `200` from this endpoint has been observed, and the
> normalizer has so far only been exercised against synthetic fixtures. The
> checklist to work through the moment real cookies exist is in
> [`backend/README.md`](backend/README.md#%EF%B8%8F-first-live-run--the-checklist-to-work-through-once-real-cookies-exist).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/profile` | `Authorization: Bearer <API_KEY>` | Fetch and normalize one profile. Body: `{ "url": "<linkedin profile url>" }`. |
| `GET` | `/health` | none | Readiness. Reports database and session state; `503` when either is bad. |

Anything else answers `404 {"error":"profile_not_found","message":"Unknown endpoint"}`
— note that a typo'd path and a genuinely missing profile share an error code, and
only the `message` tells them apart.

Routes sit at the root because [`docs/api.md`](docs/api.md) publishes them there,
and that document is the contract.

Error codes (`invalid_url`, `unauthorized`, `profile_not_found`, `rate_limited`,
`internal_error`, `upstream_schema_mismatch`, `session_unavailable`) and the full response schema are
specified in [`docs/api.md`](docs/api.md), with worked `curl` examples in
[`backend/README.md`](backend/README.md). Every key in a success response is always
present — missing data is `null` or `[]`, never omitted.

## Development

```bash
cd backend
npm test            # vitest — 139 tests across 10 files
npm run typecheck   # tsc over src/, then over tests/ and scripts/ too
npm run build       # compile to dist/
```

The highest-value test surface is the normalization layer, which is pure and runs
against saved fixtures in `backend/tests/fixtures/`. When upstream drifts, capture
a fresh payload with `npm run capture:fixture -- <profile-url> <name>` and diff it
against the last known good fixture. Gotchas, troubleshooting and open questions
live in [`docs/notes.md`](docs/notes.md).

## Deployment

Any Node host plus a managed Postgres — no custom base image and no system
dependencies, because there is no browser to install.

```bash
npm ci && npm run build && npx prisma migrate deploy && npm start
```

`backend/Dockerfile` packages the same thing as a multi-stage build on a stock
`node:22-alpine` base. It needs no browser image and no `apk add`; the ~600MB it
weighs is Prisma's engines and CLI, not us. Build and run instructions, including
running `prisma migrate deploy` out of the image, are in
[`backend/README.md`](backend/README.md#with-docker).

Set every variable from the table in [`backend/README.md`](backend/README.md), set
`NODE_ENV=production` (it is what suppresses the `stack` field on 5xx bodies) and
`CORS_ORIGINS` to the origins you actually serve, and point the platform's health
check at `GET /health`.
