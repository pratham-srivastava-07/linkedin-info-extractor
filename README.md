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
serial queue, and then answered with a single call to LinkedIn's internal Voyager
API:

```
GET /voyager/api/identity/dash/profiles
      ?q=memberIdentity
      &memberIdentity={publicId}
      &decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93
```

carrying the operator's own cookie header plus a derived `csrf-token`. That one
decoration inlines the summary, positions, education, skills, certifications and
languages, so one extraction is still one upstream request. The raw response goes
through a pure normalization layer and comes back as the published schema.

The no-browser constraint is the defining property of this system: it is why the
service deploys onto a plain Node image, why Postgres is the only stateful
dependency, and why `backend/src/linkedin/` must never grow a browser dependency.

Postgres holds three things: the profile cache, an audit row per extraction, and
session *validation state* (a SHA-256 fingerprint of the cookie header and when it
was last proven to work). Cookies themselves are never stored — they arrive from
the environment on every boot.

See [`docs/architecture.md`](docs/architecture.md) for the full component
breakdown, and [`docs/notes.md`](docs/notes.md) for the endpoint archaeology —
including why the endpoint above is *not* the one this project was originally
built against.

## Repo map

| Path | What's in it |
|---|---|
| `backend/` | The API. Express 5 + TypeScript, Prisma 6, Zod 4, Vitest. See [`backend/README.md`](backend/README.md). |
| `frontend/` | Next.js 16 + React 19 + Tailwind 4 internal test harness. Currently still the default `create-next-app` scaffold — the harness UI has not been built yet. |
| `docs/` | The contract and the reasoning: [`api.md`](docs/api.md), [`architecture.md`](docs/architecture.md), [`frontend.md`](docs/frontend.md), [`notes.md`](docs/notes.md). |
| `infra/` | [`docker-compose.yml`](infra/docker-compose.yml) — a local Postgres 16 (role `user`, database `profilelens`) with a `pg_isready` healthcheck. Nothing else; there is no Redis and no browser image. |

`CLAUDE.md` at the root states the product intent; `backend/CLAUDE.md` states the
layering rules the backend code follows.

---

## Getting started

Requires **Node** (developed on v23 — see `.nvmrc`) and **Docker**.

### 1. Clone

```bash
git clone <your-fork-or-remote> reverse-engineer
cd reverse-engineer
```

### 2. Bring up the infrastructure

```bash
docker compose -f infra/docker-compose.yml up -d
```

That is the whole infrastructure: one Postgres 16 container named `linkedin-api`,
publishing `5432`, provisioning role `user` / password `password` / database
`profilelens`. It reports healthy through `pg_isready` once it is genuinely
accepting connections, so you can wait on health rather than racing the first
connection.

There is no Redis and no browser image to pull — if you were expecting either,
read the revision note at the top of [`docs/architecture.md`](docs/architecture.md).

> **If connections are refused later**, the usual cause is a leftover volume.
> Postgres applies `POSTGRES_USER`/`POSTGRES_DB` only when it initialises an
> *empty* data directory, so a `postgres-data` volume from an earlier stack keeps
> whatever role and database it was created with. Check what the volume actually
> has with `docker exec linkedin-api psql -U user -l`, or start clean with
> `docker compose -f infra/docker-compose.yml down -v` (this deletes the data).

### 3. Set up the project

```bash
cd backend
npm install
cp .env.example .env
```

Then edit `backend/.env`:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `.env.example` already matches the compose stack: `postgresql://user:password@localhost:5432/profilelens?schema=public`. Managed Postgres usually needs `?sslmode=require`. |
| `API_KEY` | yes | Any string. Callers send it as `Authorization: Bearer <API_KEY>`. |
| `LINKEDIN_COOKIE` | one of | **Preferred.** A complete raw `cookie:` header captured from a real logged-in request, sent verbatim. |
| `LINKEDIN_LI_AT` + `LINKEDIN_JSESSIONID` | one of | The two-cookie fallback. Still supported; it is simply the request shape that has been observed getting a session revoked. |
| `PORT` | no | Default **4000**. The frontend's `next dev` takes 3000, so the two halves run side by side. |
| `CORS_ORIGINS` | no | Comma-separated browser origins, or `*` (default). |
| `LINKEDIN_PROFILE_DECORATION_ID` | no | The Voyager decoration that makes one fetch return a whole profile. Defaults to a known-good value; see "When extraction breaks" below. |

The full variable list, including the tuning knobs, is in
[`backend/README.md`](backend/README.md#environment).

**Getting the cookie.** Log into LinkedIn in a normal browser → DevTools →
**Network** → filter `voyager` → **Fetch/XHR** → reload → right-click any
`/voyager/api/...` row → **Copy as cURL (bash)** → save it as `capture.txt` →

```bash
npm run import:cookie -- capture.txt   # prints the .env lines to paste
```

Paste the printed lines into `.env` and **delete `capture.txt`** — it is a
complete authenticated request. The script only writes to stdout, never to `.env`,
and echoes cookie *names* rather than values.

`src/config/env.ts` validates the environment on import, so a missing or
incomplete credential stops the process at boot with a Zod error rather than
failing requests later.

### 4. Migrate and run

```bash
npx prisma migrate deploy
npm run dev          # http://localhost:4000
```

### 5. Check it is alive

```bash
npm run check:session          # one GET /me — no server, no database needed
curl http://localhost:4000/health
```

`{"status":"ok","database":"connected","session":"valid"}` means both Postgres and
the cookies are good. `"session":"invalid"` with HTTP 503 means the cookies were
rejected upstream. `check:session` tells you *which* kind of rejection it was —
an ordinary login wall, a security checkpoint, or an active **revocation** — and
those need different fixes. See
[`docs/notes.md`](docs/notes.md#the-two-cookie-request-gets-revoked-experiment-2026-08).

---

## Using the API

### Extract a profile

```bash
curl -s -D - -X POST http://localhost:4000/profile \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.linkedin.com/in/example-profile/"}'
```

```json
{
  "profileUrl": "https://www.linkedin.com/in/example-profile/",
  "name": "Jane Doe",
  "headline": "Senior Software Engineer at Example Co.",
  "location": "Bengaluru, Karnataka, India",
  "about": "Backend engineer focused on distributed systems...",
  "experience": [
    {
      "title": "Senior Software Engineer",
      "company": "Example Co.",
      "duration": "Jan 2022 - Present",
      "description": "Leading backend platform work..."
    }
  ],
  "education": [
    { "school": "Example University", "degree": "B.Tech, Computer Science", "duration": "2016 - 2020" }
  ],
  "skills": ["Node.js", "TypeScript", "Distributed Systems"],
  "certifications": [{ "name": "AWS Certified Developer", "issuer": "Amazon Web Services" }],
  "languages": ["English", "Hindi"],
  "profileImageUrl": "https://media.licdn.com/dms/image/...",
  "fetchedAt": "2026-08-31T11:25:27.015Z"
}
```

**Every key is always present.** A field with no data is `null`, and a list with no
entries is `[]` — neither is ever omitted, so consumers can index into the response
without existence checks.

The first call for a profile is served from upstream and carries `X-Cache: MISS`;
repeat calls within `CACHE_TTL_SECONDS` carry `X-Cache: HIT` and never touch
LinkedIn.

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/profile` | `Authorization: Bearer <API_KEY>` | Fetch and normalize one profile. Body: `{ "url": "<linkedin profile url>" }`. |
| `GET` | `/health` | none | Readiness. Reports database and session state; `503` when either is bad. |

Anything else answers `404 {"error":"profile_not_found","message":"Unknown endpoint"}`
— note that a typo'd path and a genuinely missing profile share an error code, and
only the `message` tells them apart.

Routes sit at the root because [`docs/api.md`](docs/api.md) publishes them there,
and that document is the contract.

### Errors

| Status | Body | When |
|---|---|---|
| 400 | `{"error":"invalid_url"}` | Not a `linkedin.com/in/<id>` URL. Rejected before any network call. |
| 401 | `{"error":"unauthorized"}` | Missing or wrong `Authorization` header. |
| 404 | `{"error":"profile_not_found"}` | Profile doesn't exist, or isn't visible to this session. |
| 429 | `{"error":"rate_limited","retryAfterSeconds":30}` | Upstream rate limit (HTTP 429/999), or too many callers queued. |
| 500 | `{"error":"internal_error"}` | Catch-all; the cause is logged against the `X-Request-Id`, never put in the body. |
| 502 | `{"error":"upstream_schema_mismatch"}` | Upstream changed shape, **or retired the endpoint** (HTTP 410). Either way it needs a code or config change, not new cookies. |
| 503 | `{"error":"session_unavailable"}` | Cookies expired/revoked, or LinkedIn was unreachable. |

The full schema, headers and CORS behaviour are specified in
[`docs/api.md`](docs/api.md), with more worked examples in
[`backend/README.md`](backend/README.md).

### When extraction breaks

The single most useful thing to know about this codebase: **a 4xx from upstream is
usually not about your cookies.** LinkedIn retired the endpoint this project was
originally written against, and for a long time that presented as
`503 session_unavailable` — sending everyone off to re-capture credentials that
were never the problem. So:

- **502 `upstream_schema_mismatch`** → upstream moved. Either the payload shape
  changed, or the endpoint is gone (410). Bump `LINKEDIN_PROFILE_DECORATION_ID`,
  or capture a fresh fixture and diff it. Re-copying cookies will not help.
- **503 `session_unavailable`** → *now* it really is the credential. Run
  `npm run check:session`.

[`docs/notes.md`](docs/notes.md) records the full endpoint archaeology.

---

## Development

```bash
cd backend
npm test            # vitest — 194 tests across 12 files
npm run typecheck   # tsc over src/, then over tests/ and scripts/ too
npm run build       # compile to dist/
```

The highest-value test surface is the normalization layer: pure, no I/O, and the
first thing to break when upstream changes. It runs against **real captured
payloads** in `backend/tests/fixtures/`. When upstream drifts, capture a fresh one
with `npm run capture:fixture -- <profile-url> <name>` and diff it against the last
known good fixture. Gotchas, troubleshooting and open questions live in
[`docs/notes.md`](docs/notes.md).

---

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
`CORS_ORIGINS` to the origins you actually serve.

### Deploying on Render

Render is the fast path to a public HTTPS URL. Two settings there are worth
getting right, because both defaults are wrong for this service.

#### Leave "Health Check Path" blank

Render's health check is a **restart trigger**, not a status page. If an instance
fails it, Render restarts it, and will fail a deploy or roll it back.

`GET /health` deliberately returns **503 when the LinkedIn cookie is dead**. That
is correct behaviour for a caller — it is the documented, honest signal that
extraction cannot currently work — but it is exactly the wrong thing to wire a
restart trigger to, because **no amount of restarting fixes an expired cookie.**
The credential lives in the environment and only a human pasting a fresh capture
can repair it. Point Render at `/health` and a stale cookie stops being a clean
503 to callers and becomes an availability outage: a restart loop, a deploy that
will not go green, or an automatic rollback of a perfectly good release.

So leave the field **empty**. Render then uses port binding as its liveness
signal, which is the thing a restart can actually fix. Keep `/health` for your own
monitoring and for the frontend — just don't let it reboot the box.

#### Free instances sleep — and a pinger costs upstream calls

Render's free tier spins an instance down after roughly **15 minutes** with no
inbound traffic, and the next request then pays a cold start of tens of seconds.
An external uptime pinger (UptimeRobot, Better Stack, cron-job.org) hitting
`GET /health` every **10–14 minutes** keeps it warm.

Before you set one up, understand what it costs, because `/health` is not free:
**it probes the session.** The interaction that matters:

- A session verdict is trusted for `SESSION_TTL_SECONDS` (default `3600`). Within
  that window `/health` answers from the cached verdict and makes **no** upstream
  call. So at the default TTL, a pinger every 10–14 minutes costs roughly **one
  upstream `GET /me` per hour** — negligible.
- **Lowering `SESSION_TTL_SECONDS` while a pinger is running multiplies upstream
  traffic**, and it multiplies it by whoever is polling you rather than by your
  own request volume. Set it to 600 and the same pinger now re-validates six times
  an hour; set it near the ping interval and effectively every ping becomes a
  `/me`. `docs/notes.md` records that "too many requests too quickly" is precisely
  what earns an **HTTP 999** on the account, and a 999 takes out real extractions,
  not just health checks. Treat the TTL and the ping interval as one setting with
  two halves.
- The trusted verdict is held **in process**, so it is **per instance and lost on
  every cold start**. A free instance that sleeps wakes up with an empty memo and
  re-validates on its first `/health` — which is another reason a pinger that
  prevents sleep is cheaper than one that merely wakes it.

Note that a failed validation is also remembered, for 30 seconds
(`FAILED_VALIDATION_BACKOFF_MS`), so a dead cookie cannot turn a public `/health`
endpoint into an unbounded stream of upstream requests either.
