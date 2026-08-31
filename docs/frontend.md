# frontend.md

The frontend here is a minimal internal test harness for the API — not a product surface. Its only job is to make it easy to manually verify extraction results while developing.

## Purpose

- Paste a profile URL, hit submit, see the normalized JSON (and a human-readable rendering of it) come back.
- Give a fast visual way to spot normalization bugs (missing fields, malformed dates, broken image URLs) without reading raw JSON every time.

## Stack

- Plain React (Vite), no router needed — this is a single-screen tool.
- Fetch API directly against the backend; no state management library required given the scope.

## Structure

```
frontend/
  src/
    App.tsx
    components/
      UrlForm.tsx        # input + submit
      ProfileCard.tsx     # human-readable rendering of the response
      RawJsonViewer.tsx   # collapsible raw JSON panel
      ErrorBanner.tsx      # renders api.md error shapes
    api/
      client.ts           # thin fetch wrapper, reads API key from env
    App.css
  index.html
  vite.config.ts
```

## Behavior

1. `UrlForm` takes a URL, does light client-side validation (looks like a LinkedIn profile URL), and calls `POST /profile`.
2. While the request is in flight, show a loading state — extraction can take a few seconds since it involves live browser automation upstream.
3. On success, render `ProfileCard` (name, headline, location, about, experience list, education list, skills as chips, image) plus a collapsed `RawJsonViewer` for the exact API response.
4. On error, render `ErrorBanner` mapped from the error codes in `api.md` (e.g. `profile_not_found` → "This profile couldn't be found or is private").

## Environment

```
VITE_API_BASE_URL=
VITE_API_KEY=            # fine for a local dev harness; never ship this to a public deployment
```

## Explicit non-goals

- No auth/login UI, no multi-user support, no history of past lookups, no styling polish beyond "readable." This exists to make backend development faster, not to be shipped as a product.
