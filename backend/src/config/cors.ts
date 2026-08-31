import { CorsOptions } from "cors"

/**
 * Response headers the API sets that browser JavaScript is allowed to read.
 *
 * Without this list the browser hides them: `fetch()` only exposes a short
 * safelist by default, so `res.headers.get("X-Cache")` returns null from a
 * cross-origin page no matter what the server sent. Every header here is one a
 * caller is meant to act on:
 *
 * - `X-Cache`      — HIT/MISS, so the frontend can show whether it paid for an
 *                    extraction or got a cached copy.
 * - `Retry-After`  — the standard companion to the 429 body's
 *                    `retryAfterSeconds`; useless to a browser client if unreadable.
 * - `X-Request-Id` — the id in this request's server log line, so a bug report
 *                    from the UI can be correlated with the server side.
 */
export const EXPOSED_HEADERS = ["X-Cache", "Retry-After", "X-Request-Id"] as const

/** Parses the `CORS_ORIGINS` env var into the allowlist, dropping blank entries. */
export const parseOrigins = (raw: string): string[] =>
  raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)

/**
 * Builds the `cors` options from the raw `CORS_ORIGINS` value.
 *
 * `*` (or an empty value) allows any origin. Otherwise only the listed origins
 * are echoed back; anything else simply gets no `Access-Control-Allow-Origin`
 * header, which is what makes the browser block it. An unlisted origin is not an
 * error response — the request is still served, exactly as `cors` behaves by
 * default, and exactly as a non-browser client would see it.
 */
export const buildCorsOptions = (raw: string): CorsOptions => {
  const allowed = parseOrigins(raw)
  const allowAny = allowed.length === 0 || allowed.includes("*")

  return {
    origin: allowAny ? true : allowed,
    // `Authorization` is reflected from the preflight request by default, but
    // spelling the list out means a preflight cannot start failing because a
    // browser stopped reflecting.
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "OPTIONS"],
    exposedHeaders: [...EXPOSED_HEADERS],
    // No cookies or HTTP auth are used cross-origin — the API key travels in a
    // header the caller sets explicitly — so credentialed CORS stays off. It is
    // also what lets `origin: true` be safe.
    credentials: false,
    maxAge: 600,
  }
}
