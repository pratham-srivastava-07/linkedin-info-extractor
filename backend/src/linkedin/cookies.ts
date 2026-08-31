import { createHash } from "node:crypto"

/**
 * The fallback form: the two cookies an operator can copy by hand, which we
 * assemble into a header ourselves.
 */
export interface CookiePair {
  liAt: string
  jsessionId: string
}

/**
 * The preferred form: a complete `cookie:` header captured from a real browser
 * request (`LINKEDIN_COOKIE`), sent verbatim.
 *
 * A real Voyager call carries a dozen cookies — `bcookie`, `bscookie`, `lidc`,
 * `li_gc`, `liap` and friends — not just the two that identify the session.
 * Sending only `li_at` + `JSESSIONID` got a session actively revoked (see the
 * "delete me" note in docs/notes.md), so the whole captured set is passed
 * through untouched rather than rebuilt from parts.
 */
export interface RawCookieHeader {
  raw: string
}

export type SessionCookies = CookiePair | RawCookieHeader

export const isRawCookieHeader = (cookies: SessionCookies): cookies is RawCookieHeader =>
  "raw" in cookies

/**
 * LinkedIn's CSRF scheme is self-referential: the `csrf-token` header must equal
 * the JSESSIONID cookie value with its surrounding double quotes stripped. The
 * cookie itself must still be sent *with* the quotes. Getting this wrong is the
 * single most common cause of a blanket 403 from Voyager.
 */
export const csrfTokenFrom = (jsessionId: string): string => jsessionId.replace(/"/g, "").trim()

/**
 * Pulls the JSESSIONID value out of a full `cookie:` header. Returns `null` when
 * the header has no such cookie — which is fatal for CSRF, so callers must not
 * quietly send an empty token.
 */
export const jsessionIdFrom = (rawCookieHeader: string): string | null => {
  const match = /(?:^|;)\s*JSESSIONID=([^;]*)/i.exec(rawCookieHeader)
  const value = match?.[1].trim()
  return value ? value : null
}

export const cookieHeaderFrom = (cookies: SessionCookies): string =>
  isRawCookieHeader(cookies)
    ? cookies.raw.trim()
    : // Always rebuilt from the stripped value: a hand-pasted env var can arrive
      // quoted, unquoted, or half-quoted, and only one of those spellings is a
      // valid cookie.
      `li_at=${cookies.liAt.trim()}; JSESSIONID="${csrfTokenFrom(cookies.jsessionId)}"`

/** The `csrf-token` header value for either cookie form. */
export const csrfTokenFor = (cookies: SessionCookies): string =>
  isRawCookieHeader(cookies)
    ? csrfTokenFrom(jsessionIdFrom(cookies.raw) ?? "")
    : csrfTokenFrom(cookies.jsessionId)

/**
 * Stable, non-reversible id for a cookie *set* — see the Session model comment.
 *
 * It hashes the exact header string that goes on the wire, so it covers
 * everything actually being sent. That matters for both forms: LinkedIn rotates
 * JSESSIONID independently of the login cookie, and a stale JSESSIONID produces
 * the blanket 403 documented in docs/notes.md, so fingerprinting `li_at` alone
 * would leave the old "ACTIVE, validated 10 minutes ago" row matching the new
 * cookie set and the rotation would be trusted without ever being re-checked.
 * For a captured header the same argument applies to every other cookie in it —
 * swapping the capture must invalidate the cached verdict.
 */
export const fingerprint = (cookies: SessionCookies): string =>
  createHash("sha256").update(cookieHeaderFrom(cookies)).digest("hex")
