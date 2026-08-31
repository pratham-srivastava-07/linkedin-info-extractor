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

## Status: what has and has not been proven

Worth being blunt about, because the gap is not obvious from the test count:

- **Proven.** 182 tests across 12 files. The normalization layer against fixtures;
  the HTTP contract end to end over a real Express server; the Voyager client's
  status mapping; the serial queue; the session manager's TTL, rotation and
  retry behaviour; CORS headers on the wire; the request logger's no-headers
  guarantee; the captured-cookie path — verbatim passthrough, CSRF derived from
  the raw string, the fingerprint following what is actually sent, the two-cookie
  fallback still working — and the revocation classifier and the cURL parser, all
  against stubbed input. Separately, by hand: a Postgres outage against a running
  build (the service kept answering with the real upstream error, not a `500`), and the
  Docker image booting, connecting to Postgres, serving `/health` and `/profile`,
  running `prisma migrate deploy`, and shutting down cleanly on `SIGTERM`.
- **Not proven.** A successful extraction. No `200` from `POST /profile` has ever
  been observed. The only live success anywhere in this project is a single
  `GET /voyager/api/me`, and it was followed by the revocation described above.
  The three fixtures in `tests/fixtures/` are synthetic, written from the
  documented Voyager shape rather than captured from a real response, so the
  mapping in `normalizeProfile.ts` is an informed guess about field names until
  someone runs the checklist in `backend/README.md` against a live session.

## Known limitations

- Session lifetime on the upstream platform is not officially documented — TTL in `SESSION_TTL_SECONDS` is an estimate and may need tuning based on observed expiry behavior. It only controls how often we re-validate, not the cookie's real lifetime.
- The normalization layer is built against the current upstream response shape; upstream can change this without notice, which will surface as `upstream_schema_mismatch` errors until the mapping is updated. Note it has not yet been checked against a *real* payload — see "Status" above.
- Only one authenticated session is maintained at a time — this is a deliberate simplicity/resilience tradeoff, not a scalability design. Scaling to many concurrent extractions would need a pool of sessions, which is out of scope for now.
- Some profile fields (certifications, languages) are only present on profiles where the owner filled them in — `null`/`[]` in the response can mean either "not present" or "not disclosed," and we can't currently distinguish those.
- Profile images are returned as upstream-hosted URLs, not re-hosted/cached — if upstream URLs expire, the image link may go stale after the fact.
- Extraction reads one Voyager surface (`profileView`). Anything that surface omits — recommendations, publications, volunteering — is not available without additional calls.

## Testing strategy

- Unit test the normalization layer against saved fixture JSON (raw upstream shape → expected `Profile` output) — this is the highest-value test surface since it's pure and has no I/O.
- Keep 3-5 fixtures covering: a fully-filled-out profile, a minimal/sparse profile, and one with an unusual/edge-case field (e.g. multiple current positions).
- `npm run capture:fixture -- <profile-url> [name]` saves a real raw payload into `tests/fixtures/`. Use it to add a fixture from a live profile, and to capture a fresh payload when upstream drifts.
- For the extraction layer itself, prefer a small number of manual/integration smoke tests over heavy automated coverage — it depends on live upstream behavior that's expensive to mock realistically.

## Troubleshooting

- **`session_unavailable` on every request** → the credential has expired or was revoked (logging out of LinkedIn in the browser invalidates it). Grab a fresh one — but run `npm run check:session` first, because "expired" and "revoked" look identical from the service and only one of them is fixed by re-copying. Repeated automated requests from a new IP can also trigger a security checkpoint on the account.
- **Blanket 403 from Voyager with a cookie you know is good** → the `csrf-token` header doesn't match `JSESSIONID`. The header takes the value with quotes stripped; the cookie keeps them.
- **HTTP 999 from upstream** → LinkedIn's anti-automation response, usually a missing or unrecognised `user-agent`, or too many requests too quickly. Surfaces to callers as `429 rate_limited`.
- **A 302 instead of JSON** → redirect to the login wall, which is how an expired session usually presents. The client treats it as an auth failure, not a successful response. Run `npm run check:session` to find out *which* kind of 302 it is — the two cases below need different fixes.
- **A 302 whose `Set-Cookie` deletes `li_at`** (`li_at="delete me"`, `Expires=Thu, 01-Jan-1970`, `Max-Age=0`, usually alongside `li_a` and `liap`) → **revocation, not expiry.** LinkedIn is throwing the credential away, which is a different failure from a cookie that timed out: a fresher copy of the same two cookies gets revoked the same way, in our case within about three minutes of a request that had genuinely worked. What is being rejected is the *shape* of the request, not the age of the cookie. Fix: log in again in the browser, take a full capture (`npm run import:cookie`), set `LINKEDIN_COOKIE` plus the optional `x-li-*` headers, and stop retrying in between — repeated attempts escalate to a checkpoint. `check:session` reports this as `REVOKED` and names the cookies that were deleted. See "The two-cookie request gets revoked" above.
- **A 302 to `/checkpoint/`** → the account needs attention in a normal browser (a verification prompt). No cookie you paste will work until it is cleared.
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
- [ ] Run the live-extraction checklist in `backend/README.md` and capture a real fixture. This is the one item blocking "success criteria 1" in `CLAUDE.md` from being genuinely met.
- [ ] Confirm or kill the request-fidelity hypothesis: does a full `LINKEDIN_COOKIE` capture (plus `x-li-track` / `x-li-page-instance`) survive longer than the ~3 minutes the two-cookie form did? Needs one fresh session and patience between attempts.
- [ ] `x-li-pem-metadata` is sent by the real client and we do not send it. Worth adding only if the capture above still gets revoked.
- [ ] `SESSION_TTL_SECONDS=3600` is still a guess; the live run is the first chance to observe real expiry behaviour and tune it.
