# api.md

Public API contract for ProfileLens.

## Base URL

```
https://<your-deployment-domain>
```

Locally the API listens on **port 4000** (`http://localhost:4000`). It is not 3000
because the Next.js frontend in `frontend/` takes that one.

## Authentication

All requests (except `/health`) require an API key:

```
Authorization: Bearer <API_KEY>
```

## Endpoints

### `POST /profile`

Fetch and return a normalized profile.

**Request body**

```json
{
  "url": "https://www.linkedin.com/in/example-profile/"
}
```

**Success response — `200 OK`**

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
    {
      "school": "Example University",
      "degree": "B.Tech, Computer Science",
      "duration": "2016 - 2020"
    }
  ],
  "skills": ["Node.js", "TypeScript", "Distributed Systems"],
  "certifications": [
    { "name": "AWS Certified Developer", "issuer": "Amazon Web Services" }
  ],
  "languages": ["English", "Hindi"],
  "profileImageUrl": "https://media.example.com/profile.jpg",
  "fetchedAt": "2026-08-30T10:00:00Z"
}
```

Every field is always present in the response; fields with no data are `null` (or `[]` for list fields) rather than omitted, so consumers can rely on a stable shape.

**Error responses**

| Status | Meaning | Example body |
|---|---|---|
| 400 | Malformed or missing URL | `{ "error": "invalid_url", "message": "url must be a valid LinkedIn profile URL" }` |
| 401 | Missing/invalid API key | `{ "error": "unauthorized" }` |
| 404 | Profile not found or private | `{ "error": "profile_not_found" }` |
| 429 | Rate limited (by us or upstream) | `{ "error": "rate_limited", "retryAfterSeconds": 30 }` |
| 500 | Unexpected server fault | `{ "error": "internal_error", "message": "Something went wrong. Please try again" }` |
| 502 | Upstream returned an unexpected shape | `{ "error": "upstream_schema_mismatch" }` |
| 503 | Session could not be established | `{ "error": "session_unavailable" }` |

`internal_error` is the catch-all: anything that is not one of the failures above
is scrubbed down to it, so a driver message, a connection string or a stack trace
can never ride out in a response body. If you see it, the cause is in the server
log under the `X-Request-Id` of your request — it is not something a caller can
fix by changing the request.

**The `stack` field.** Responses with a status of 500 or above carry an extra
`stack` string **when the server runs with `NODE_ENV=development`**. It is a
debugging aid for local work and is absent in production; treat it as
non-contractual and never parse it.

### Response headers

| Header | On | Meaning |
|---|---|---|
| `X-Cache` | `200` | `HIT` if the profile came from the cache, `MISS` if it was extracted. |
| `Retry-After` | `429` | Seconds to wait; mirrors `retryAfterSeconds` in the body. |
| `X-Request-Id` | every response | Correlates with the server's log line for this request. Send your own to have it adopted. |

All three are listed in `Access-Control-Expose-Headers`, so browser JavaScript can
read them cross-origin (see **CORS** below).

### Unknown endpoints

A request to a path this API does not serve is answered with:

```
404 {"error":"profile_not_found","message":"Unknown endpoint"}
```

This is worth reading carefully, because it is easy to misdiagnose: **a typo'd
path returns the same `error` code as a real profile that could not be found.**
The `"message": "Unknown endpoint"` is what distinguishes them, so check it before
concluding that a profile is private or deleted. The same applies to a valid path
with the wrong method — `GET /profile` is routed nowhere and so answers with this
404, not a `405`.

The behaviour is deliberate and will not change: `profile_not_found` is the only
404 in this document's vocabulary, and integrations already match on it.

### CORS

The API is designed to be called directly from a browser. `CORS_ORIGINS` on the
server sets the allowlist — a comma-separated list of origins, or `*` for any.
An origin that is not on the list simply gets no `Access-Control-Allow-Origin`
header back, which is what makes the browser block the response; the request is
not rejected with an error status, and a non-browser client is unaffected either
way.

Preflights accept `Authorization` and `Content-Type`. Credentialed CORS is off:
the API key travels in a header the caller sets explicitly, never as a cookie, so
`fetch` should not be given `credentials: "include"`.

### `GET /health`

Liveness/readiness check.

**Response — `200 OK`**

```json
{ "status": "ok", "database": "connected", "session": "valid" }
```

Returns `503` with `"status": "degraded"` if the database is unreachable or the current session is invalid and could not be revalidated.

## Rate limits

- Default: 1 concurrent extraction request processed at a time per deployment (queued), to avoid triggering upstream anti-automation defenses.
- Cached results (if caching is enabled) are served instantly and don't count against extraction throughput.
- The queue is depth-capped. Callers arriving past the cap receive `429` immediately rather than waiting behind a long queue; `429` responses also carry a `Retry-After` header alongside `retryAfterSeconds`.

## Versioning

The response schema is versioned implicitly by this document. Any breaking change to field names or types should bump a version prefix (e.g. `/v2/profile`) rather than silently changing the existing contract.
