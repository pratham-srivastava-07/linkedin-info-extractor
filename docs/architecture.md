# architecture.md

How ProfileLens is put together. Read `CLAUDE.md` first for *why*; this is *how*.

> **Revised.** An earlier draft of this document specified headless-browser
> extraction (Playwright) and Redis-backed session/queue infrastructure. The
> requirement is now a **purely reverse-engineered solution that hits LinkedIn's
> endpoints directly, with no browser**, so the extraction layer is a plain HTTP
> client and the supporting infrastructure collapsed to a single Postgres. There
> is no browser binary, and no Redis, anywhere in the system.

## High-level flow

```
Client
  │  POST /profile { url }
  ▼
API layer (Express)
  │  validate URL → reject bad input before any network call
  ▼
Cache (Postgres) ──hit──► normalized profile, returned immediately
  │miss
  ▼
Serial queue  ──► one extraction at a time
  │
  ▼
Session manager ──► cookies validated recently? ──no──► revalidate upstream
  │yes                                                        │
  ▼                                                           ▼
Extraction layer (HTTPS → Voyager API)              503 session_unavailable
  │
  ▼
Normalization layer (pure)
  │
  ▼
JSON response to client
```

## Components

### 1. API layer
- Framework: Express 5 + TypeScript.
- Responsibilities: input validation (is this a well-formed profile URL?), auth on
  our own API (static API key in an `Authorization: Bearer` header), request
  logging, CORS, error formatting.
- Request logging is a hand-rolled middleware, not morgan: the requirement is one
  line (`id method path status duration`) and one hard rule — **no header is ever
  logged**, because the API key is in `Authorization` and the upstream cookies are
  in `cookie`. Query strings are stripped for the same reason. The id is echoed as
  `X-Request-Id` and prefixes any error logged for that request.
- CORS is an allowlist from `CORS_ORIGINS`, defaulting to `*`. It publishes
  `X-Cache`, `Retry-After` and `X-Request-Id` in `Access-Control-Expose-Headers` —
  without that the browser hides them from `fetch` and the headers are dead weight
  to the frontend. Credentialed CORS is off: the API key is an explicit header,
  never an ambient cookie, so a permissive origin default grants an attacker
  nothing they could not already do with curl.
- Knows nothing about how extraction works — it calls a service and returns what
  comes back.
- Routes live at the root (`POST /profile`, `GET /health`) because `api.md`
  publishes them there and that document is the contract.

### 2. Session manager
- Owns the authenticated context used to reach upstream.
- Credentials are the operator's own, supplied through environment variables (the
  own-credentials model in `CLAUDE.md`), in one of two forms:
  - `LINKEDIN_COOKIE` — a **complete raw `cookie:` header captured from a real
    logged-in request**, sent verbatim. This is the preferred form. A genuine
    Voyager call carries a dozen cookies (`bcookie`, `bscookie`, `lidc`, `li_gc`,
    `liap`, `JSESSIONID`, `li_at`, …); sending only the two that identify the
    session is a request shape LinkedIn has been observed to *revoke* rather than
    merely reject — see the `"delete me"` finding in `notes.md`. We do not try to
    reconstruct that jar, we pass through what the browser actually sent.
  - `LINKEDIN_LI_AT` + `LINKEDIN_JSESSIONID` — the original two-cookie fallback,
    kept working so existing setups don't break.
  `config/env.ts` fails fast on boot unless one of the two forms is complete, and
  a captured header must contain `li_at` and `JSESSIONID` — the latter because the
  CSRF token is derived from it (see §3) and a header without one 403s every call.
- There is **no scripted login flow**: a password POST against `/uas/authenticate`
  is the step most likely to trigger a checkpoint or CAPTCHA from a server IP, and
  it buys nothing that a pasted cookie doesn't already give us.
- What Postgres stores is *validation state*, not credentials: a SHA-256
  fingerprint of the exact cookie header that goes on the wire, when it was last
  proven to work, and when we should re-check. Fingerprinting what is actually
  sent — rather than `li_at` alone — is what makes a swapped or rotated cookie set
  a different identity, so an old "ACTIVE, validated 10 minutes ago" row cannot
  vouch for it. Cookies never touch the database. Re-validation costs one cheap
  `GET /me` and happens at most once per `SESSION_TTL_SECONDS`.
- The same verdict is also held **in process**, and that is what bounds our
  outbound traffic. The Postgres row survives a restart; the in-memory copy
  survives a *database outage*. Without it, an unreadable `sessions` table turns
  every request into an extra `GET /me`, and a dead cookie turns every
  unauthenticated `/health` poll into one — with the request rate set by whoever
  is calling `/health`, not by us. `docs/notes.md` records that "too many requests
  too quickly" is exactly what earns an HTTP 999 on the account, so both the
  success and the failure path have to be self-limiting. A failed validation is
  therefore remembered for `FAILED_VALIDATION_BACKOFF_MS` (30s) and answered from
  memory. This never delays recovery: new cookies arrive in the environment, which
  means a restart, which clears it.
- Interface: `getSession()`, `invalidateSession()`, `describe()`, `probe()`.

### 3. Extraction layer
- Given valid session cookies and a public profile id, retrieves the raw profile
  data by calling LinkedIn's internal Voyager API over plain HTTPS.
- The surface is the **dash profiles finder**:

  ```
  GET /voyager/api/identity/dash/profiles
        ?q=memberIdentity
        &memberIdentity={publicId}
        &decorationId={LINKEDIN_PROFILE_DECORATION_ID}
  ```

  It is a restli *finder*, so the profile arrives wrapped in `elements` even
  though exactly one is ever matched: `{ elements: [profile], paging }`.
- **The decoration is what keeps this to one request.** Without it — or with the
  top-card decoration the web client uses — the response carries only the header
  fields, with `experienceCard` / `educationCard` as bare urn references and no
  summary, skills, certifications or languages at all. With
  `com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`
  the same call inlines `summary`, `profilePositionGroups`, `profileEducations`,
  `profileSkills`, `profileCertifications` and `profileLanguages`. So one
  extraction remains one upstream request, and the serial queue still sees a
  single call per job.
- **The decoration id is configuration, not a constant.** Its version suffix
  rotates on LinkedIn's schedule exactly the way a GraphQL `queryId` hash does,
  so it lives in `LINKEDIN_PROFILE_DECORATION_ID` with the observed-good value as
  its default. When upstream retires one, that is an environment change, not a
  redeploy.
- **This is not the endpoint the project was originally built against**, and the
  difference cost real time. The legacy
  `GET /identity/profiles/{publicId}/profileView` — and the rest of the
  `/identity/profiles/*` family — now answers **HTTP 410 Gone**. See
  `docs/notes.md`; the failure-modes table below records how that is classified
  now.
- Three headers carry the session, and the third is the one people get wrong:
  - `cookie:` — either the captured header verbatim, or `li_at=…; JSESSIONID="…"`
    assembled from the fallback pair. JSESSIONID stays **quoted** here.
  - `csrf-token: …` — the same JSESSIONID value with the quotes **stripped**. When
    the credential is a captured header, JSESSIONID is parsed back out of it to
    derive this; the derivation is identical for both forms and is not optional. A
    mismatch produces a blanket 403 that looks like an expired session.
  - `x-restli-protocol-version: 2.0.0`, plus a desktop `user-agent` — Voyager
    answers unrecognised agents with HTTP 999.
- Optionally, the tracking headers a real web client sends: `x-li-track` and
  `x-li-page-instance`, from `LINKEDIN_X_LI_TRACK` / `LINKEDIN_X_LI_PAGE_INSTANCE`,
  and a `user-agent` override in `LINKEDIN_USER_AGENT`. They are sent **only when
  set**: these values belong to the browser session they were captured with, and a
  stale one is worse than none. Together with the full cookie jar they are the
  working hypothesis for why a two-cookie request gets revoked — request fidelity,
  not credential age. A full captured header has now served many consecutive
  requests without being revoked, including a successful extraction, which is
  consistent with the hypothesis but does not isolate it as the cause.
- The header set lives in `src/linkedin/headers.ts` and is shared with
  `scripts/check-session.ts`, so the diagnostic and the service put byte-identical
  requests on the wire. That module reads the optional headers from `process.env`
  rather than `config/env`, because the script has to run before `DATABASE_URL`
  exists.
- Returns raw, unshaped JSON exactly as received.
- **Status classification is where most of the hard-won knowledge lives**, because
  three of these codes do not mean what they look like:

  | Upstream | Internal signal | Why |
  |---|---|---|
  | 3xx | `UpstreamAuthError` | The login wall. An expired cookie presents as a redirect, not a 401. |
  | 401 | `UpstreamAuthError` | Genuine rejection. |
  | 403 **with** `exceptionClass: com.linkedin.voyager.common.VoyagerUserVisibleException` | `UpstreamNotFoundError` | **The finder never 404s.** A private profile, an out-of-network profile and a public id that does not exist all come back as this 403. Reading it as an auth failure would invalidate a healthy session and 503 the whole service because one profile happened to be unreadable. |
  | 403, any other body | `UpstreamAuthError` | The CSRF/session case — a `csrf-token` that does not match `JSESSIONID`. |
  | 404 | `UpstreamNotFoundError` | Kept for other paths; the profiles finder does not appear to use it. |
  | 410 | `UpstreamGoneError` | **A retired endpoint, never a dead session.** Surfaces as `502`, not `503`. |
  | 429 / 999 | `UpstreamRateLimitError` | 999 is LinkedIn's own anti-automation response. |
  | `elements: []` | `UpstreamNotFoundError` | A finder that matched nothing is a missing profile. Classified here so the normalizer never has to decide, and the caller gets `404` rather than `502`. |

### 4. Normalization layer
- Pure functions, no I/O, no clock, no config. Raw Voyager JSON in, the public
  `Profile` schema out (see `api.md`).
- This is where "upstream changed their field names again" gets absorbed — one
  place to fix, not scattered across the codebase.
- Unit-tested against saved fixture responses (see `notes.md`).
- When the payload no longer matches expectations it raises a typed
  `SchemaMismatchError` carrying the raw payload, rather than quietly returning a
  profile full of nulls.

### 5. Serial queue / rate limiter
- An in-process serial queue holds outbound extractions to one at a time, so a
  single authenticated session never has concurrent requests fired against it.
- This is what BullMQ was doing in the earlier design. With one process and one
  session, an in-process queue is the same behaviour without a second piece of
  infrastructure to run, deploy and monitor.
- The queue is depth-capped: past the cap callers get an immediate `429
  rate_limited` instead of piling up behind a timeout.
- Cache hits bypass the queue entirely — they cost no upstream throughput.

### 6. Cache
- Postgres `cached_profiles`, keyed by public id, holding the normalized payload
  with an expiry. Serves repeat lookups of the same profile for
  `CACHE_TTL_SECONDS` without touching upstream. Set `CACHE_TTL_SECONDS=0` to
  disable.

### 7. Audit log
- Every extraction writes one `extraction_jobs` row: URL, outcome, error code,
  duration, cache hit. This is what makes "fields suddenly all null" diagnosable
  after the fact. Failing to write the log never fails the request.

## Directory structure

```
backend/
  prisma/
    schema.prisma
    migrations/
  src/
    config/          env.ts, cors.ts
    routes/          profile.ts, health.ts, index.ts
    controllers/     profile.ts, health.ts, index.ts
    services/        profile.ts, health.ts, index.ts
    repositories/    session, profileCache, extractionJob
    linkedin/        voyagerClient.ts, sessionManager.ts, cookies.ts, headers.ts,
                     revocation.ts, errors.ts
    normalization/   normalizeProfile.ts, dates.ts
    validators/      profile.ts, index.ts
    interfaces/      profile.ts, linkedin.ts, error.ts
    middlewares/     apiKey.ts, requestLogger.ts
    utils/           AppError.ts, error.ts, serialQueue.ts, shutdown.ts
    helpers/         prisma.ts
    index.ts
  tests/
    fixtures/
    normalization.test.ts   profileUrl.test.ts     serialQueue.test.ts
    voyagerClient.test.ts   sessionManager.test.ts profileService.test.ts
    api.test.ts             cors.test.ts           requestLogger.test.ts
    upstreamTimeout.test.ts rawCookie.test.ts      sessionDiagnostics.test.ts
  scripts/          capture-fixture.ts, check-session.ts, import-cookie.ts, curl.ts
  Dockerfile         multi-stage, stock node:22-alpine, no browser layer
  .dockerignore      excludes .env — the operator's live cookies
frontend/            (see frontend.md)
```

Dependencies run one way: `Routes → Controllers → Services → Repositories →
Prisma`. Business logic never sits in a controller; Prisma calls never leave a
repository. `linkedin/` and `normalization/` are consumed by the service layer.

## Environment variables

```
PORT=                    # default 4000 — 3000 belongs to the frontend's `next dev`
NODE_ENV=                # `production` suppresses the `stack` field on 5xx bodies
API_KEY=                 # for authenticating callers of our own API
CORS_ORIGINS=            # comma-separated browser origins, or `*` (default)
DATABASE_URL=
LINKEDIN_COOKIE=         # preferred: a full captured `cookie:` header, used verbatim
LINKEDIN_LI_AT=          # fallback: operator's own session cookie
LINKEDIN_JSESSIONID=     # fallback: paired with LINKEDIN_LI_AT
LINKEDIN_USER_AGENT=     # optional; defaults to the desktop UA in linkedin/headers.ts
LINKEDIN_X_LI_TRACK=     # optional; sent only when set
LINKEDIN_X_LI_PAGE_INSTANCE=  # optional; sent only when set
LINKEDIN_PROFILE_DECORATION_ID=  # optional; the restli decoration that makes one
                         # fetch return a whole profile. Its version suffix rotates
                         # like a GraphQL queryId hash, so it is config, not a
                         # constant. Defaults to the observed-good value.
SESSION_TTL_SECONDS=     # how long a validated session is trusted before re-checking
CACHE_TTL_SECONDS=       # 0 disables profile caching
UPSTREAM_TIMEOUT_MS=
```

`.env.example` is the authoritative list and matches what `config/env.ts` reads.
Its `DATABASE_URL` matches what `infra/docker-compose.yml` provisions: role `user`,
database `profilelens`.

## Deployment

- Target: Render or Railway for a fast path to a public HTTPS URL with minimal
  DevOps overhead.
- A **stock Node image is enough**. `backend/Dockerfile` is a multi-stage build on
  `node:22-alpine` with no `apk add` at all: dropping the browser removed the
  Playwright base image, the system libraries headless Chromium needs, and the
  cold-start cost that came with them. This is the main practical benefit of the
  direct-HTTP approach beyond the requirement itself. It is not, however, a small
  image — it lands around 600MB, essentially all of it Prisma's engines and CLI,
  which arrive as optional peer dependencies of `@prisma/client` and cannot be
  pruned. The CLI at least earns its place: `prisma migrate deploy` runs out of
  the same artifact that gets deployed.
- Needs a Postgres instance and the environment variables above. Run
  `prisma migrate deploy` on release.
- `GET /health` verifies Postgres connectivity and session validity, so the
  platform's health checks catch a dead session early.

## Failure modes to design around

| Failure | Handling |
|---|---|
| Session expired mid-request | Retry once with a revalidated session before failing |
| Session cookie dead / login wall | `503 session_unavailable`; a 302 to the login page counts as an auth failure |
| Session actively revoked upstream | Same `503` in the service — but `npm run check:session` names it: a `Set-Cookie` deleting `li_at` (`"delete me"`, `Max-Age=0`) is a revocation, not an expiry, and the fix is a fuller capture rather than a fresher cookie |
| Upstream returns unexpected shape | Normalization throws `SchemaMismatchError`, raw payload logged, client gets a clean `502` |
| **Upstream retires the endpoint (410)** | `UpstreamGoneError` → `502 upstream_schema_mismatch`, **not** `503`. A retired endpoint is a code/config problem — no credential fixes it — and letting it wear the costume of a dead session is what sent this project chasing cookies for hours. The error message says so explicitly. |
| Profile private, out of network, or nonexistent | Upstream answers `403` with `VoyagerUserVisibleException`; classified as not-found → `404`, and the session is **not** invalidated |
| Invalid/malformed URL | `400` before any extraction attempt |
| Profile private/not found | `404 profile_not_found`, not a generic 500 |
| Rate limited upstream (429 or 999) | `429 rate_limited` with `retryAfterSeconds` and a `Retry-After` header |
| Too many queued callers | Immediate `429` rather than an unbounded wait |
| Upstream unreachable / timeout | `503`, capped by `UPSTREAM_TIMEOUT_MS` — which bounds a connection that stalls *mid-body*, not just one that never connects |
| Postgres unreachable | Cache reads/writes, audit-log writes and session-state reads are each swallowed and logged. The request still runs; the caller sees the real upstream outcome, never a `500` caused by the dead cache. `/health` reports `degraded` so the platform pulls the instance |
| Anything unanticipated | Scrubbed to `500 internal_error`; the cause is logged against the request id and never put in the body |
