# CLAUDE.md — ProfileLens API

Declarative knowledge about this product. Read this first before making changes — it explains *what we're building and why*, not *how the code is laid out* (see `architecture.md` for that).

## What this is

ProfileLens is a hosted API that takes a public professional-profile URL (LinkedIn) and returns a clean, structured JSON representation of that profile — name, headline, location, about, experience, education, skills, certifications, languages, and profile image.

Think of it as a data-normalization service: the upstream source (LinkedIn's own internal API surface) returns deeply nested, inconsistent, versioned JSON. ProfileLens's entire value proposition is turning that into a stable, predictable, well-documented schema that a downstream product (a CRM enrichment tool, a recruiting dashboard, a sales-intelligence app) can consume without ever touching LinkedIn's messy internals directly.

## Core value proposition

- **One clean schema, always.** Callers never see LinkedIn's raw response shape. If the upstream shape changes, that's absorbed in our normalization layer — the public contract doesn't move.
- **Session reuse, not repeated logins.** Authenticate once, cache the session, serve many requests without re-authenticating per call.
- **Predictable failure modes.** Expired sessions, missing fields, and rate limits all produce documented, typed errors — never a silent partial response.

## Who uses this

Backend/product teams that need profile data as an input to something else (enrichment pipelines, lead scoring, recruiting tools) and don't want to build and maintain their own scraping/normalization layer.

## Domain concepts

- **Profile** — the normalized output object (see `api.md` for the exact schema).
- **Session** — an authenticated browser/HTTP context capable of fetching profile data. Sessions expire and must be refreshed.
- **Extraction job** — a single request to fetch + normalize one profile URL.
- **Field confidence** — some fields (e.g. `about`) may be absent on a given profile; the schema always includes the key with `null` rather than omitting it.

## Constraints and principles

- **Own-credentials model.** The service operates using session credentials the operator supplies — it does not manage third-party user logins.
- **Resilience over cleverness.** Prefer approaches that degrade gracefully (partial data, clear error) over approaches that are fast but brittle.
- **No credentials in source.** All secrets live in environment variables, never committed.
- **Schema stability is a first-class feature.** Changes to the public response schema are breaking changes and should be treated as such (versioned, documented).

## Non-goals (for now)

- Bulk/batch scraping of many profiles in parallel at scale.
- Scraping platforms other than LinkedIn.
- A polished multi-user frontend — the frontend here is a thin internal test harness, not a product surface.

## Success criteria for this build

1. A publicly reachable HTTPS endpoint that accepts a profile URL and returns structured JSON.
2. Session handling that survives more than one request without re-authenticating every time.
3. Clear, typed error responses for the common failure modes (invalid URL, expired session, profile not found/private).
4. A README/API doc good enough that someone unfamiliar with the code could integrate against it in minutes.
