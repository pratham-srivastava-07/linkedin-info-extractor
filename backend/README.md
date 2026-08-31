# ProfileLens API

Takes a public LinkedIn profile URL, returns a clean, stable JSON representation of
that profile.

Extraction is **purely reverse-engineered**: the service speaks HTTPS directly to
LinkedIn's internal Voyager API using the operator's own session cookies. There is
no browser, no headless Chromium, and no automation driver anywhere in the request
path — which is also why it deploys onto a plain Node image and starts cold in
under a second.

The full request/response contract lives in [`../docs/api.md`](../docs/api.md).

---

## Quick start

```bash
cd backend
npm install
cp .env.example .env      # then fill in the values below
npx prisma migrate deploy # or: npm run prisma:migrate
npm run dev               # http://localhost:4000
```

### Environment

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. Managed Postgres usually needs `?sslmode=require`. |
| `API_KEY` | yes | Callers send this as `Authorization: Bearer <API_KEY>`. |
| `LINKEDIN_COOKIE` | one of | **Preferred.** A complete raw `cookie:` header captured from a real logged-in request, sent verbatim. See [Getting your upstream credentials](#getting-your-upstream-credentials). |
| `LINKEDIN_LI_AT` | one of | Fallback: your LinkedIn session cookie on its own. |
| `LINKEDIN_JSESSIONID` | one of | Fallback: your LinkedIn CSRF cookie, e.g. `ajax:1234567890`. Must be set together with `LINKEDIN_LI_AT`. |
| `PORT` | no | Port the API listens on. Default `4000` — **not** 3000, which `next dev` in `../frontend` uses. |
| `NODE_ENV` | no | Default `development`. Set it to `production` when you deploy: it is what suppresses the `stack` field on 5xx error bodies. |
| `CORS_ORIGINS` | no | Comma-separated browser origins allowed to call the API, or `*` for any. Default `*`. |
| `SESSION_TTL_SECONDS` | no | How long a validated session is trusted before re-checking upstream. Default `3600`. |
| `CACHE_TTL_SECONDS` | no | How long a normalized profile is cached. `0` disables caching. Default `3600`. |
| `UPSTREAM_TIMEOUT_MS` | no | Ceiling on a single upstream request. Default `15000`. |
| `LINKEDIN_USER_AGENT` | no | Overrides the desktop user-agent sent upstream. Defaults to the constant in `src/linkedin/headers.ts`. |
| `LINKEDIN_X_LI_TRACK` | no | The captured `x-li-track` header (a JSON blob). Sent only when set. |
| `LINKEDIN_X_LI_PAGE_INSTANCE` | no | The captured `x-li-page-instance` header. Sent only when set. |
| `LINKEDIN_PROFILE_DECORATION_ID` | no | The restli decoration that makes one fetch return a whole profile. Defaults to `com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`. Its version suffix rotates on LinkedIn's schedule, so this is the first thing to bump if extraction starts failing with a 4xx that is clearly not about the session. |

**"one of"** means exactly that: `src/config/env.ts` refuses to boot unless either
`LINKEDIN_COOKIE` or the `LINKEDIN_LI_AT` + `LINKEDIN_JSESSIONID` pair is present.
When `LINKEDIN_COOKIE` is set it wins and the pair is ignored. A captured header
must also contain both `li_at` and `JSESSIONID` — the second is where the
`csrf-token` header comes from, and without it every request 403s — so that is
checked at boot too, with a message that names the variable and never prints its
value.

The three optional headers are what `npm run import:cookie` prints alongside the
cookie. They are sent only when set: a stale `x-li-track` is worse than none,
because these values belong to the specific browser session they came from.

### Getting your upstream credentials

The credentials are the operator's own; the service does not manage third-party
logins. There are two ways to supply them, and they are not equally reliable.

#### Preferred: capture a whole request (`LINKEDIN_COOKIE`)

A real Voyager call carries a dozen cookies — `bcookie`, `bscookie`, `lidc`,
`li_gc`, `liap`, `JSESSIONID`, `li_at` and more — plus tracking headers. Sending
only `li_at` and `JSESSIONID` has been observed to get a session **actively
revoked** rather than merely rejected (see the "delete me" entry in
[`../docs/notes.md`](../docs/notes.md)). So copy the real thing:

1. Log into LinkedIn in a normal browser.
2. DevTools → **Network** → filter `voyager` → **Fetch/XHR** → reload the page.
3. Right-click any `/voyager/api/...` row → **Copy** → **Copy as cURL (bash)**.
4. Save it to a file, e.g. `capture.txt`, then:

```bash
npm run import:cookie -- capture.txt
# or pipe it in:  Get-Clipboard | npm run import:cookie
```

5. Paste the printed lines into `backend/.env`. It prints `LINKEDIN_COOKIE`, plus
   `LINKEDIN_USER_AGENT` / `LINKEDIN_X_LI_TRACK` / `LINKEDIN_X_LI_PAGE_INSTANCE`
   when the capture carried them.
6. **Delete `capture.txt`.** It is a complete authenticated request.

The script only writes to stdout — it never edits `.env` for you, so a paste of the
wrong request cannot silently replace a working configuration. It echoes cookie
*names* to stderr so you can confirm the capture, never values.

#### Fallback: the two cookies (`LINKEDIN_LI_AT` + `LINKEDIN_JSESSIONID`)

1. Log into LinkedIn in a normal browser.
2. DevTools → **Application** → **Cookies** → `https://www.linkedin.com`.
3. Copy the `li_at` value into `LINKEDIN_LI_AT`.
4. Copy the `JSESSIONID` value into `LINKEDIN_JSESSIONID` (keep it exactly as
   shown — the quotes are handled for you).

This still works and is still supported. It is simply the shape that got a session
revoked in testing, so reach for it only when a full capture is inconvenient.

Either way, logging out of that browser session invalidates the credential, and the
API will start returning `503 session_unavailable` until you paste a fresh one.

#### Check before you run

```bash
npm run check:session
```

Sends one `GET /voyager/api/me` with exactly the headers the service would send and
prints a verdict. It never prints cookie values, exits `0` only when the session is
live, and works without `DATABASE_URL`. On a redirect it distinguishes an **active
revocation** (upstream returned `li_at="delete me"` with `Max-Age=0`) from an
ordinary login wall or a security checkpoint, because the fixes are different — see
[`../docs/notes.md`](../docs/notes.md).

---

## Usage

### Extract a profile

```bash
curl -X POST http://localhost:4000/profile \
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
  "fetchedAt": "2026-08-30T10:00:00.000Z"
}
```

**Every key is always present.** A field with no data is `null`, and a list with no
entries is `[]` — neither is ever omitted, so consumers can index into the response
without existence checks. A cache hit is flagged with an `X-Cache: HIT` response
header.

### Health

```bash
curl http://localhost:4000/health
```

```json
{ "status": "ok", "database": "connected", "session": "valid" }
```

Returns `503` with `"status": "degraded"` if Postgres is unreachable or the session
is dead — point your platform's health check here so a dead cookie takes the
instance out of rotation.

### Errors

Every failure returns a documented code, never a stack trace or a partial profile.

| Status | Body | When |
|---|---|---|
| 400 | `{"error":"invalid_url","message":"url must be a valid LinkedIn profile URL"}` | Not a `linkedin.com/in/<id>` URL. Rejected before any network call. |
| 401 | `{"error":"unauthorized"}` | Missing or wrong `Authorization` header. |
| 404 | `{"error":"profile_not_found"}` | Profile doesn't exist, or isn't visible to this session. Upstream signals both as a `403 VoyagerUserVisibleException`; mapping it here keeps one unreadable profile from invalidating a healthy session. |
| 429 | `{"error":"rate_limited","retryAfterSeconds":30}` | Upstream rate limit (HTTP 429/999), or too many callers queued. Also sets `Retry-After`. |
| 500 | `{"error":"internal_error","message":"Something went wrong. Please try again"}` | Catch-all for an unexpected fault. Anything unrecognised is scrubbed down to this, so a driver message or connection string can never reach a response body. |
| 502 | `{"error":"upstream_schema_mismatch"}` | Upstream changed shape, **or retired the endpoint** (HTTP 410). The raw payload is logged for diffing. Either way it needs a code or config change — not a fresh cookie. |
| 503 | `{"error":"session_unavailable"}` | Cookies expired/revoked, or LinkedIn was unreachable. |

A response of 500 or above also carries a `stack` field **when `NODE_ENV=development`**.
It is a local debugging aid, is absent in production, and is not part of the contract.

**Unknown endpoints** answer `404 {"error":"profile_not_found","message":"Unknown endpoint"}`
— the same `error` code a genuinely missing profile gets. If you are debugging a
404, read the `message` before concluding the profile is private: `"Unknown endpoint"`
means the *path* was wrong. `GET /profile` (right path, wrong method) lands here
too, rather than on a `405`. The behaviour is kept as-is because callers already
match on `profile_not_found`.

```bash
# 400
curl -X POST http://localhost:4000/profile -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" -d '{"url":"https://example.com/in/nope"}'

# 401
curl -X POST http://localhost:4000/profile \
  -H "Content-Type: application/json" -d '{"url":"https://www.linkedin.com/in/x/"}'
```

### Response headers

| Header | On | Meaning |
|---|---|---|
| `X-Cache` | `200` | `HIT` (served from the Postgres cache) or `MISS` (freshly extracted). |
| `Retry-After` | `429` | Seconds to wait, mirroring `retryAfterSeconds`. |
| `X-Request-Id` | every response | The id in the server's log line for this request. Send your own `X-Request-Id` and it is adopted. |

### Calling from a browser

`CORS_ORIGINS` is the allowlist. During development the default `*` means the
frontend just works; in production set it to the origins you actually serve:

```bash
CORS_ORIGINS="https://app.example.com,https://staging.example.com"
```

All three response headers above are published in `Access-Control-Expose-Headers`,
so `res.headers.get("X-Cache")` works cross-origin. An origin that is not on the
list gets no `Access-Control-Allow-Origin` header, which is what makes the browser
block it — the server does not return an error status for it.

Do **not** use `credentials: "include"`. The API key is an explicit header, not a
cookie, and credentialed CORS is deliberately off:

```js
const res = await fetch("http://localhost:4000/profile", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ url }),
})
const cache = res.headers.get("X-Cache") // "HIT" | "MISS"
```

### Request logging

Every request produces one line on stdout:

```
[http] 3caa868d-c7de-48e1-b9af-fb652052d29c POST /profile 503 599ms
```

Request id, method, path, status, duration — and nothing else. **No header is ever
logged**, because the API key rides in `Authorization` and the upstream cookies
ride in `cookie`. Query strings are stripped for the same reason. The same request
id prefixes any error the request caused, so a `500` in a bug report can be traced
to its log line.

---

## How it works

```
POST /profile → validate URL → cache lookup → serial queue → session → Voyager → normalize → JSON
```

- **Session manager** holds the upstream context. Credentials come from env —
  either the captured `LINKEDIN_COOKIE` header or the `li_at` + `JSESSIONID`
  fallback; Postgres stores only a SHA-256 fingerprint of the exact header that
  goes on the wire, plus validation state, never the credentials themselves. Swap
  the capture and the fingerprint changes, so a stale "validated" row cannot vouch
  for a different cookie set. A session is re-verified with one cheap `GET /me` at
  most once per `SESSION_TTL_SECONDS`. If a request fails auth mid-flight it
  retries exactly once with a revalidated session.
- **Voyager client** issues a single request per extraction:

  ```
  GET /identity/dash/profiles?q=memberIdentity&memberIdentity={publicId}
                             &decorationId={LINKEDIN_PROFILE_DECORATION_ID}
  ```

  carrying the cookie, the derived `csrf-token`, and
  `x-restli-protocol-version: 2.0.0`, plus `x-li-track` / `x-li-page-instance` when
  they are configured. The CSRF token is the `JSESSIONID` value with its quotes
  stripped — read out of the captured header when there is one — while the cookie
  keeps them. That derivation is the most common cause of an unexplained 403, so
  it survives both credential forms and is checked at boot.

  The **decoration** is what keeps this to one round trip: it inlines the summary,
  positions, education, skills, certifications and languages that the default
  projection returns only as urn references. Its version suffix rotates like a
  GraphQL `queryId` hash, which is why it is an environment variable rather than a
  constant. The legacy `/identity/profiles/{publicId}/profileView` surface this
  client used to call now returns **HTTP 410 Gone** — see
  [`../docs/notes.md`](../docs/notes.md).
- **Serial queue** allows one outbound extraction at a time, so the single session
  never has concurrent requests fired at it. Cache hits skip the queue.
- **Normalization** is pure functions with no I/O — raw Voyager JSON in, the
  published schema out. If upstream drifts it raises `SchemaMismatchError` (→ 502)
  rather than returning a profile full of nulls.
- **Audit log**: every request writes an `extraction_jobs` row (outcome, error
  code, duration, cache hit). Logging never fails a good extraction.

Layering is strict and one-directional:
`Routes → Controllers → Services → Repositories → Prisma`.

---

## Live extraction — what has been observed

**A successful extraction has now been run end to end.** On **2026-08-31**, against
the operator's own profile with a full captured `LINKEDIN_COOKIE`:

```
POST /profile  →  200
X-Cache: MISS          1426 ms
```

All twelve documented keys present, and the list fields genuinely populated rather
than silently empty: `experience` 3, `education` 3, `skills` 20,
`certifications` 11. `languages` came back `[]` because that profile lists none.
Repeating the identical request:

```
POST /profile  →  200
X-Cache: HIT           23 ms
```

The cached payload was deep-equal to the extracted one, and no second
`GET /voyager/api/me` was issued — that is session reuse, success criterion 2 in
the root `CLAUDE.md`. `GET /health` reported
`{"status":"ok","database":"connected","session":"valid"}`.

What is still *not* observed: a profile that actually lists **languages**. Every
profile sampled had `profileLanguages.paging.total === 0`, so that one collection's
element shape is inferred from its siblings rather than confirmed. It maps
defensively and returns `[]`.

### Reproducing it

**1. Capture a real request into `backend/.env`.**

DevTools → Network → filter `voyager` → Fetch/XHR → reload → right-click a
`/voyager/api/...` row → Copy as cURL (bash) → save as `capture.txt` →
`npm run import:cookie -- capture.txt` → paste the printed lines → delete
`capture.txt`. The full procedure is under
["Getting your upstream credentials"](#getting-your-upstream-credentials).

`src/config/env.ts` validates on import, so a missing or incomplete credential
stops the process at boot instead of failing requests later.

**2. Start Postgres and the API.**

```bash
docker compose -f ../infra/docker-compose.yml up -d
npx prisma migrate deploy
npm run dev
```

**3. Confirm the session is live.** This is the gate — do not go further until it
passes.

```bash
npm run check:session        # cheapest check: one GET /me, no server, no database
curl -s http://localhost:4000/health
```

Expect `{"status":"ok","database":"connected","session":"valid"}`. A `503` with
`"session":"invalid"` means the credential was rejected; run `check:session` and
read its verdict (**REVOKED** / **login wall** / **checkpoint** / **rate limited**)
before re-copying anything, because those need different fixes.

**4. Extract one real profile.**

```bash
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2- | tr -d '"')

curl -s -D /dev/stderr -X POST http://localhost:4000/profile   -H "Authorization: Bearer $API_KEY"   -H "Content-Type: application/json"   -d '{"url":"https://www.linkedin.com/in/YOUR-PROFILE-SLUG/"}' | jq .
```

Check, in this order:

- status is `200` and `X-Cache: MISS` (headers go to stderr via `-D /dev/stderr`);
- `name` and `headline` are populated — if both were empty the request would have
  been a `502`, so a `200` already proves the top of the mapping;
- `experience`, `education` and `skills` are non-empty **on a profile that clearly
  has entries**. Any of them being `[]` there is the signal that a field moved.

**5. Prove the cache and session reuse.** Run the exact same command again and
expect `X-Cache: HIT`. A second `MISS` means `CACHE_TTL_SECONDS` is `0` or the
cache write failed — the write is non-fatal by design, so check stdout for
`[profile_cache] write failed`. Neither request should have logged a second
`GET /me`.

**6. Capture a fixture if you need one.**

```bash
npm run capture:fixture -- https://www.linkedin.com/in/SOME-PUBLIC-FIGURE/ my-fixture
```

This writes the raw finder response — `{ elements: [profile], paging }` — not the
normalized output. **Prefer public figures for anything committed**, and never
commit a capture of a private profile: the payload is a complete profile and
carries anti-abuse uuids and signed image URLs.

### If it does not return 200

The one distinction worth internalising, because getting it backwards is what cost
this project the most time:

| Response | Meaning | Fix |
|---|---|---|
| `502 upstream_schema_mismatch` | Upstream moved: the payload shape changed, **or the endpoint was retired** (HTTP 410). | Bump `LINKEDIN_PROFILE_DECORATION_ID`, or capture a fresh fixture and diff it. **Not a cookie problem** — the log line for the request id will say so. |
| `503 session_unavailable` | *Now* it really is the credential. | `npm run check:session`, then re-capture. |
| `404 profile_not_found` | The profile is private, out of network, or does not exist. Upstream signals this as a `403 VoyagerUserVisibleException`, which the client deliberately maps to 404 so that one unreadable profile cannot invalidate a healthy session. | Try a profile the session can see. |
| `429 rate_limited` | HTTP 429 or 999 upstream. | **Stop.** Retrying is what escalates to an account checkpoint. |

The full endpoint archaeology — what returns 410, what replaced it, and the exact
shapes — is in [`../docs/notes.md`](../docs/notes.md).

## Development

```bash
npm run dev            # watch mode
npm test               # unit tests — 194 across 12 files
npm run typecheck      # tsc over src/, then over tests/ and scripts/ too
npm run build          # compile to dist/
npm start              # run the build

npm run check:session  # will LinkedIn accept the configured credential right now?
npm run import:cookie -- capture.txt   # curl blob → the .env lines to paste
```

`check:session` and `import:cookie` both run without `DATABASE_URL` and never print
a cookie value.

### Fixtures

The normalization layer is the highest-value test surface — pure, no I/O, and the
first thing to break when upstream changes. Tests run against saved fixtures in
`tests/fixtures/`.

```bash
npm run capture:fixture -- https://www.linkedin.com/in/example-profile/ my-fixture
```

saves a real raw payload you can assert against — the whole finder response,
`{ elements: [profile], paging }`. When profiles start coming back with null
fields, capture a fresh one and diff it against the last known good fixture to
find what moved.

The three committed fixtures are **real captures of public figures**, chosen to
cover different shapes: one fully filled out (skills, a certification, a degree
with a field of study), one genuinely sparse (`paging.total === 0` across several
collections), and one edge case (five position groups, plus an education entry
with no `schoolName` at all). Shapes none of them happens to carry — a position
`description`, whitespace-only strings, a group with no nested positions — are
covered by objects trimmed by hand from real captures, labelled as such in
`tests/normalization.test.ts`.

Two things to know before adding one:

- **Never commit a capture of a private profile**, or of your own. These payloads
  are complete profiles and carry anti-abuse uuids and signed image URLs.
- `vitest.config.ts` pins `LINKEDIN_COOKIE: ""` on purpose. `config/env.ts` calls
  `dotenv.config()`, which fills in anything vitest has not set — so without that
  line the suite behaves differently depending on whether the developer happens to
  have a real cookie in `.env`, and the live value shows up in assertion diffs.

## Deployment

Any Node host (Render, Railway, Fly) plus a managed Postgres. No system
dependencies and no custom base image — there is no browser to install.

### From source

```bash
npm ci && npm run build && npx prisma migrate deploy && npm start
```

### With Docker

A multi-stage `Dockerfile` on a stock `node:22-alpine` base is included.

```bash
docker build -t profilelens-backend .

docker run -p 4000:4000 \
  -e DATABASE_URL="postgresql://user:password@host:5432/profilelens?schema=public" \
  -e API_KEY="..." \
  -e LINKEDIN_COOKIE='bcookie="..."; JSESSIONID="ajax:..."; li_at=...; lidc="..."' \
  -e CORS_ORIGINS="https://app.example.com" \
  profilelens-backend
```

The image sets `NODE_ENV=production` and `PORT=4000`, runs as the unprivileged
`node` user, and runs `node` as PID 1 in exec form so `SIGTERM` reaches the
graceful-shutdown handler directly.

**Migrations.** The `prisma` CLI ships inside the image (it arrives as an optional
peer dependency of `@prisma/client` and cannot be pruned), so migrations run from
the same artifact you deploy:

```bash
docker run --rm --entrypoint npx \
  -e DATABASE_URL="postgresql://..." \
  profilelens-backend prisma migrate deploy
```

**On image size:** roughly 600MB, and essentially all of it is Prisma's engines
and CLI. The no-browser architecture is not a promise of a tiny image — what it
buys is a stock base image, zero system packages to patch, and a sub-second cold
start, rather than a Playwright base with headless Chromium underneath it.

Set every required variable from the table above, and point the platform health
check at `GET /health`.
