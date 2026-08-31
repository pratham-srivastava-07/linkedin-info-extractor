# notes.md

Running development notes. Update this as decisions get made or gotchas get discovered — this is the "tribal knowledge" file, not the polished docs.

## Setup

1. `cd backend && npm install`.
2. Copy `.env.example` to `.env`, fill in `DATABASE_URL`, `API_KEY`, and the
   upstream credential — either `LINKEDIN_COOKIE` (preferred; see "Getting the
   cookies" below) or the `LINKEDIN_LI_AT` + `LINKEDIN_JSESSIONID` pair. Boot
   fails fast if neither is complete.
3. `npm run prisma:migrate` (or `npx prisma migrate deploy` against an existing db).
4. `npm run dev` starts the API on **port 4000**; `npm run dev` inside `frontend/`
   starts the test harness on 3000. The backend default was moved off 3000 for
   exactly this reason — both halves now run at once without a collision.
5. `CORS_ORIGINS` defaults to `*`, so the harness can call the API straight away.
   Set it to a real list before deploying.

No browser binaries and no Redis — the extraction path is plain HTTPS to LinkedIn's
Voyager API, and Postgres is the only stateful dependency.

## Getting the cookies

**Preferred: capture a whole request.** DevTools → Network → filter `voyager` →
Fetch/XHR → reload → right-click a `/voyager/api/...` row → Copy as cURL (bash).
Save it, run `npm run import:cookie -- capture.txt`, paste the lines it prints into
`.env`, then delete the capture file. The script prints to stdout only — it never
writes `.env` itself — and echoes cookie *names*, never values. It also picks up
`user-agent`, `x-li-track` and `x-li-page-instance` when the capture has them.

Why bother: see "The two-cookie request gets revoked" below. Two cookies is not
what a browser sends, and that appears to matter.

**Fallback: the two cookies.** DevTools → Application → Cookies →
`https://www.linkedin.com`, and copy `li_at` and `JSESSIONID`. Keep the
`JSESSIONID` value exactly as shown, quotes included — `cookies.ts` handles the
quoted/unquoted forms, but the CSRF token must be the value *without* quotes while
the cookie keeps them. That derivation is unchanged for a captured header: the
JSESSIONID is parsed back out of the raw string to build `csrf-token`, which is why
`config/env.ts` refuses a `LINKEDIN_COOKIE` that has no JSESSIONID in it.

`npm run check:session` vets whichever form is configured before you start the
server. It needs no database and prints no cookie values.

## The two-cookie request gets revoked (experiment, 2026-08)

The single most useful thing learned so far, and the reason `LINKEDIN_COOKIE`
exists. Sequence, with only `li_at` + `JSESSIONID` on the wire:

1. `GET /voyager/api/me` returned a **real HTTP 200** — the cookies were genuinely
   valid and the endpoint and headers were right.
2. Roughly **three minutes later**, the next request came back `302`, carrying:

   ```
   li_at  value="delete me"  Expires=Thu, 01-Jan-1970  Max-Age=0
   li_a   value="delete me"  Max-Age=0
   liap   value="delete me"  Max-Age=0
   ```

That `Set-Cookie` is LinkedIn **actively revoking the session** — deleting the
credential on its side — not a cookie reaching its own expiry, and not a redirect
bounce. It is also why the 3xx-as-auth-failure classification in
`voyagerClient.ts` is correct and should stay.

The working hypothesis is **request fidelity**, not credential age: a real Voyager
call carries the whole cookie jar (`bcookie`, `bscookie`, `lidc`, `li_gc`, `liap`,
`JSESSIONID`, `li_at`, …) plus tracking headers (`x-li-track`,
`x-li-page-instance`, `x-li-pem-metadata`); we were sending two cookies and none of
those. Hence `LINKEDIN_COOKIE` (verbatim passthrough of a captured header) and the
optional `LINKEDIN_USER_AGENT` / `LINKEDIN_X_LI_TRACK` /
`LINKEDIN_X_LI_PAGE_INSTANCE`.

**The hypothesis is untested.** The operator's session was revoked at the time of
writing, and repeated failed attempts escalate toward a hard account checkpoint, so
no further live calls were made. Nobody has yet seen a full capture succeed, and no
`200` from `POST /profile` has ever been observed. Treat this as the best
explanation available, not as a fix known to work.

## The endpoint we were built against is gone (experiment, 2026-08-31)

**This is the single most important entry in this file.** It is the actual reason
extraction never worked, and it was never a credential problem.

`GET /voyager/api/identity/profiles/{publicId}/profileView` — the one surface the
whole extraction layer was written around — returns **HTTP 410 Gone**.
`/identity/profiles/{id}/networkinfo` is 410 as well, so assume the entire legacy
`/identity/profiles/*` family has been retired.

Why this burned so much time: **410 fell through to a generic "unavailable" and
surfaced to callers as `503 session_unavailable`.** That is the code that means
"your cookies are dead". So every diagnostic pointed at credentials — re-capture,
re-paste, check for revocation — while the session was provably fine the whole
time (`GET /voyager/api/me` returned 200 either side of the failing calls). A
retired endpoint was wearing the costume of an expired cookie.

The fix is a typed `UpstreamGoneError` mapped to **`502 upstream_schema_mismatch`**,
with a message that says in so many words that this is not a session problem and
re-capturing cookies will not help. **Do not "simplify" 410 back into the
unavailable branch.**

### What replaced it

```
GET /voyager/api/identity/dash/profiles
      ?q=memberIdentity
      &memberIdentity={publicId}
      &decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93
```

Observed statuses, all on one healthy session:

| Request | Status | Notes |
|---|---|---|
| `…/dash/profiles?q=memberIdentity&memberIdentity=<id>` (no decoration) | **200** | ~7.8 KB. Top-card fields only. |
| `…&decorationId=…WebTopCardCore-6` | **200** | ~14 KB. Still top-card: `experienceCard` / `educationCard` are `{ entityUrn, $recipeType }` references, and summary/skills/certifications/languages are absent entirely. |
| `…&decorationId=…FullProfileWithEntities-93` | **200** | 32–75 KB. **Everything inlined.** This is the one to use. |
| same, for a profile the session cannot see | **403** | See "403 is not what you think" below. |
| same, for a public id that does not exist | **403** | Identical body. The finder never 404s. |
| legacy `…/identity/profiles/{id}/profileView` | **410** | Retired. |

`FullProfileWithEntities-93` returns, on one element of `elements`:
`firstName`, `lastName`, `headline`, `summary`, `publicIdentifier`, `entityUrn`,
`objectUrn`, `industry`, `geoLocation.geo`, `profilePicture`,
`profilePositionGroups`, `profileEducations`, `profileSkills`,
`profileCertifications`, `profileLanguages`, plus a dozen collections we do not
map (projects, honours, patents, publications, courses, volunteering, test
scores, organizations).

**Treat the `-93` suffix as rotating.** It is the same class of thing as a GraphQL
`queryId` hash: a server-side registered projection whose version moves on
LinkedIn's schedule. It lives in `LINKEDIN_PROFILE_DECORATION_ID` so a rotation is
an env change, not a code change. If extraction starts returning 4xx that are
clearly not about the session, bump this first.

### Shape notes that are easy to get wrong

- **Positions are grouped by employer.** `profilePositionGroups.elements[]` is one
  group per company; the actual roles are nested a level deeper in
  `profilePositionInPositionGroup.elements[]`. Two roles at one company is one
  group with two positions. The normalizer flattens this; reading only the group
  level silently loses job titles.
- **`dateRange: { start, end }`**, not the legacy `timePeriod: { startDate, endDate }`.
- **The photo is one level deeper**: `profilePicture.displayImageReference.vectorImage`,
  then root URL + the largest artifact's `fileIdentifyingUrlPathSegment`.
- **`location` is useless**; it is only `{ countryCode: "US" }`. The human-readable
  place is `geoLocation.geo.defaultLocalizedName` ("Seattle, Washington, United
  States"). The normalizer deliberately never falls back to the country code — a
  bare "US" is worse than `null` for a field documented as
  "Bengaluru, Karnataka, India".
- **Education can arrive with no `schoolName`**, carrying only a nested `school`
  object (observed on a real profile). Falling back to `school.name` is what keeps
  that entry from disappearing.
- **Skills/certification names** have a `multiLocaleName` map alongside `name`;
  either can be the populated one.

### 403 is not what you think

A profile that is private, out of network, or simply does not exist all come back
as:

```
403 {"exceptionClass":"com.linkedin.voyager.common.VoyagerUserVisibleException",
     "message":"This profile can't be accessed","status":403}
```

Confirmed by probing a nonexistent slug and a real-but-inaccessible profile on a
session that returned 200 immediately before and after. **The dash profiles finder
never 404s.**

This matters because the old client mapped every 403 to an auth failure. Left
alone, reading one profile the operator cannot see would invalidate a perfectly
good session and 503 the entire service. The client now splits on the body:
`VoyagerUserVisibleException` → `profile_not_found` (404); any other 403 → auth
failure, which is still the right call for the CSRF-mismatch case.

### Rate discipline while probing

All of the above was established in **10 upstream requests total**, at least 2
seconds apart, with every raw response saved to disk so it could be studied
offline instead of re-fetched. No retry-on-failure loops. This is not optional
politeness: the operator's personal account is the only test credential the
project has, one session was already revoked, and a checkpoint would end the
ability to test at all.

## Status: what has and has not been proven

Worth being blunt about, because the gap is not obvious from the test count:

- **Proven, live, on 2026-08-31: a real `200` from `POST /profile`.** This had
  never happened before. Against the operator's own profile, on the port in `.env`
  (3000), with a full captured `LINKEDIN_COOKIE`:
  - `200` with `X-Cache: MISS`, 1426 ms, all twelve documented keys present;
  - `experience` (3), `education` (3), `skills` (20), `certifications` (11)
    genuinely populated — not silently `[]`; `languages` `[]` because that profile
    lists none;
  - a second identical request: `200` with `X-Cache: HIT`, 23 ms, payload
    deep-equal to the first, and **no second `GET /me`** — session reuse, which is
    success criterion 2 in `CLAUDE.md`;
  - `GET /health` → `{"status":"ok","database":"connected","session":"valid"}`.
- **Proven.** 194 tests across 12 files. The normalization layer against **real
  captured payloads**; the HTTP contract end to end over a real Express server; the
  Voyager client's status mapping including the 410 and the two flavours of 403;
  the serial queue; the session manager's TTL, rotation and retry behaviour; CORS
  headers on the wire; the request logger's no-headers guarantee; the
  captured-cookie path — verbatim passthrough, CSRF derived from the raw string,
  the fingerprint following what is actually sent, the two-cookie fallback still
  working — and the revocation classifier and the cURL parser, all against stubbed
  input. Separately, by hand: a Postgres outage against a running build (the
  service kept answering with the real upstream error, not a `500`), and the
  Docker image booting, connecting to Postgres, serving `/health` and `/profile`,
  running `prisma migrate deploy`, and shutting down cleanly on `SIGTERM`.
- **Still not proven.** That `languages` ever populates: every profile sampled had
  `profileLanguages.paging.total === 0`, so the element shape (`name` /
  `multiLocaleName` / `proficiency`) is **inferred** from its sibling collections
  and the legacy `languageView`, not observed. It is mapped defensively and
  returns `[]` — which is contract-compliant either way — but the first profile
  that actually lists a language is the test. Also unproven: real session expiry
  behaviour, so `SESSION_TTL_SECONDS=3600` is still a guess.

## Known limitations

- Session lifetime on the upstream platform is not officially documented — TTL in `SESSION_TTL_SECONDS` is an estimate and may need tuning based on observed expiry behavior. It only controls how often we re-validate, not the cookie's real lifetime.
- The normalization layer is built against the current upstream response shape; upstream can change this without notice, which will surface as `upstream_schema_mismatch` errors until the mapping is updated. It has been checked against real captured payloads (see "Status" above), but "real today" is not "stable" — this is an internal API with no versioning commitment to us.
- Only one authenticated session is maintained at a time — this is a deliberate simplicity/resilience tradeoff, not a scalability design. Scaling to many concurrent extractions would need a pool of sessions, which is out of scope for now.
- Some profile fields (certifications, languages) are only present on profiles where the owner filled them in — `null`/`[]` in the response can mean either "not present" or "not disclosed," and we can't currently distinguish those.
- Profile images are returned as upstream-hosted URLs, not re-hosted/cached — if upstream URLs expire, the image link may go stale after the fact.
- Extraction reads one Voyager surface (the dash profiles finder with
  `FullProfileWithEntities`). The decoration does return projects, honours,
  patents, publications, courses, volunteering, test scores and organizations, but
  the public schema in `api.md` has no fields for them, so they are dropped rather
  than exposed. Adding any of them is a schema change, hence a versioning decision.
- **Injected sub-collections are capped upstream, and `paging.total` tells you
  when.** Skills come back at most 20 at a time (a real profile with
  `total: 27` returned 20), position groups at most 10. So `skills` can be a
  *prefix* of the truth, not the whole of it. Nothing in the response marks it as
  truncated once normalized — if completeness matters, compare
  `profileSkills.paging.total` against `elements.length` in the raw payload.
- `languages` has never been observed populated on any profile sampled; see
  "Status" above. It maps defensively and returns `[]`.
- `location` comes from `geoLocation.geo.defaultLocalizedName`. Profiles that
  expose only a country code get `null`, deliberately — see the shape notes above.

## Testing strategy

- Unit test the normalization layer against saved fixture JSON (raw upstream shape → expected `Profile` output) — this is the highest-value test surface since it's pure and has no I/O.
- The three fixtures in `tests/fixtures/` are **real captured payloads**, not
  synthetic ones, and all three are public figures on purpose — the directory is
  checked in and each file is a complete profile:
  - `full-profile.json` — summary, 8 skills, a certification, education with a
    degree *and* a field of study, a photo;
  - `sparse-profile.json` — genuinely sparse: `paging.total === 0` for skills,
    certifications and languages, no degrees, no position descriptions;
  - `edge-profile.json` — five position groups, an education entry carrying **no**
    `schoolName` (only the nested `school` object), and two with no `dateRange`.
- A handful of shapes no sampled profile happened to carry (a position
  `description`, a position group with no nested positions, whitespace-only
  strings, a missing name) are covered in `normalization.test.ts` by objects
  **trimmed by hand from real captures** — every field name in them was observed on
  a live 200. They are labelled as such in the file.
- **Do not commit a fixture captured from a private profile**, and do not commit
  the operator's own: these payloads are complete, and they carry anti-abuse uuids
  and signed image URLs.
- `vitest.config.ts` pins `LINKEDIN_COOKIE: ""`. That is load-bearing: `config/env.ts`
  calls `dotenv.config()`, which fills in any key vitest has not set, so without it
  a developer with a real cookie in `backend/.env` runs a *different suite* from
  one without (the captured header wins over the two-cookie pair) — and the live
  cookie ends up printed in assertion diffs.
- `npm run capture:fixture -- <profile-url> [name]` saves a real raw payload into `tests/fixtures/`. Use it to add a fixture from a live profile, and to capture a fresh payload when upstream drifts.
- For the extraction layer itself, prefer a small number of manual/integration smoke tests over heavy automated coverage — it depends on live upstream behavior that's expensive to mock realistically.

## Troubleshooting

- **`session_unavailable` on every request** → the credential has expired or was revoked (logging out of LinkedIn in the browser invalidates it). Grab a fresh one — but run `npm run check:session` first, because "expired" and "revoked" look identical from the service and only one of them is fixed by re-copying. Repeated automated requests from a new IP can also trigger a security checkpoint on the account.
- **Blanket 403 from Voyager with a cookie you know is good** → the `csrf-token` header doesn't match `JSESSIONID`. The header takes the value with quotes stripped; the cookie keeps them.
- **HTTP 999 from upstream** → LinkedIn's anti-automation response, usually a missing or unrecognised `user-agent`, or too many requests too quickly. Surfaces to callers as `429 rate_limited`.
- **A 302 instead of JSON** → redirect to the login wall, which is how an expired session usually presents. The client treats it as an auth failure, not a successful response. Run `npm run check:session` to find out *which* kind of 302 it is — the two cases below need different fixes.
- **A 302 whose `Set-Cookie` deletes `li_at`** (`li_at="delete me"`, `Expires=Thu, 01-Jan-1970`, `Max-Age=0`, usually alongside `li_a` and `liap`) → **revocation, not expiry.** LinkedIn is throwing the credential away, which is a different failure from a cookie that timed out: a fresher copy of the same two cookies gets revoked the same way, in our case within about three minutes of a request that had genuinely worked. What is being rejected is the *shape* of the request, not the age of the cookie. Fix: log in again in the browser, take a full capture (`npm run import:cookie`), set `LINKEDIN_COOKIE` plus the optional `x-li-*` headers, and stop retrying in between — repeated attempts escalate to a checkpoint. `check:session` reports this as `REVOKED` and names the cookies that were deleted. See "The two-cookie request gets revoked" above.
- **A 302 to `/checkpoint/`** → the account needs attention in a normal browser (a verification prompt). No cookie you paste will work until it is cleared.
- **`502 upstream_schema_mismatch` out of nowhere** → this is the code that now
  covers *both* a changed payload shape *and* a **retired endpoint** (HTTP 410).
  Check the server log for the request id: `UpstreamGoneError` names the path and
  says explicitly that it is not a session problem. The fix is either a new
  `LINKEDIN_PROFILE_DECORATION_ID` or a new endpoint — **never** a fresh cookie.
  This distinction exists because the opposite mistake cost this project hours.
- **`404 profile_not_found` on a profile you can see in your browser** → the
  session that owns the cookie cannot see it (out of network, or private). The
  finder returns `403 VoyagerUserVisibleException` for that, and the client maps
  it to 404 on purpose so one unreadable profile cannot invalidate the session.
- **Fields suddenly all null** → upstream likely changed their internal response shape; run `capture:fixture` and diff the result against the last known fixture to find what moved. A total shape change raises `502 upstream_schema_mismatch` instead of returning nulls.
- **Postgres connection refused in deployment** → check the platform's networking rules; managed Postgres usually requires SSL (`?sslmode=require` on the `DATABASE_URL`).
- **Postgres connection refused locally** → the compose stack provisions role `user` / db `profilelens`, but Postgres only applies those when initialising an *empty* data directory. A `postgres-data` volume from an earlier stack keeps its original role. Check with `docker exec linkedin-api psql -U user -l`, or reset with `docker compose -f infra/docker-compose.yml down -v`.
- **Everything 503s but `/health` says `database: connected`** → the cookies are dead. Note a failed validation is cached for 30 seconds, so after pasting fresh ones you must restart the process, not just wait.
- **The frontend can't read `X-Cache`** → it is exposed via `Access-Control-Expose-Headers`, so this means the request's origin is not in `CORS_ORIGINS`, or the browser is sending `credentials: "include"` (which the server deliberately does not allow).
- **A 404 you did not expect** → `{"message":"Unknown endpoint"}` means the *path* was wrong, not the profile. A typo'd path and a missing profile share the `profile_not_found` code.

## Open questions / TODO

- [ ] Decide on caching TTL for normalized results (tradeoff: freshness vs. reducing load on the extraction layer). Currently 1 hour.
- [ ] Decide whether to re-host profile images ourselves to avoid link rot.
- [ ] Add a `/v2` versioning plan once the schema needs its first breaking change.
- [ ] Consider a periodic sweep of expired `cached_profiles` rows — `deleteExpired()` exists but nothing calls it on a schedule yet.
- [ ] Same for `sessions`: every cookie rotation writes a new fingerprint row and nothing ever removes the old ones. Harmless (they are tiny and never matched again) but unbounded.
- [x] ~~Run the live-extraction checklist and capture a real fixture.~~ **Done
      2026-08-31**: `POST /profile` returned `200` with populated experience,
      education, skills and certifications, and all three fixtures are now real
      captures. Success criterion 1 in `CLAUDE.md` is met.
- [ ] Find a profile that actually lists languages and confirm the
      `profileLanguages` element shape. It is the last field mapped from inference
      rather than observation.
- [ ] Confirm or kill the request-fidelity hypothesis. A full `LINKEDIN_COOKIE`
      capture has now survived a dozen upstream requests spread over a working
      session, including a successful extraction — where the two-cookie form was
      revoked within ~3 minutes. Consistent with the hypothesis, but not an
      isolation of the cause; nothing was held constant except the cookie form.
- [ ] Decide whether to expose the collections `FullProfileWithEntities` returns
      but `api.md` has no fields for (projects, honours, publications,
      volunteering, courses). That is a schema change, so it needs a version.
- [ ] Decide whether to paginate the capped sub-collections (skills stop at 20).
      Doing so costs extra upstream requests per extraction, which is exactly the
      thing the rate discipline exists to limit.
- [ ] `x-li-pem-metadata` is sent by the real client and we do not send it. Worth adding only if the capture above still gets revoked.
- [ ] `SESSION_TTL_SECONDS=3600` is still a guess; the live run is the first chance to observe real expiry behaviour and tune it.
