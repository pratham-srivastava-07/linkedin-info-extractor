/**
 * Tells apart the two things a 3xx from Voyager can mean.
 *
 * Observed by experiment: with only `li_at` + `JSESSIONID` on the wire, LinkedIn
 * served one real `GET /voyager/api/me` (200) and then, minutes later, answered
 * with a 302 carrying
 *
 *   set-cookie: li_at="delete me"; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=0
 *
 * for `li_at`, `li_a` and `liap`. That tombstone is an *active revocation* —
 * upstream deleting the session because the request did not look like a real
 * client — not a cookie that aged out and not a redirect bounce. A plain login
 * redirect with no such header is the ordinary expired/logged-out case.
 *
 * Pure, and takes strings rather than a `Headers` so it can be tested without a
 * fetch response. Nothing here touches cookie *values*; only names are reported.
 */
export type AuthFailureKind = "revoked" | "checkpoint" | "login_wall" | "unknown"

export interface AuthFailureDiagnosis {
  kind: AuthFailureKind
  /** Names of the cookies upstream told us to delete. Never their values. */
  revokedCookies: string[]
}

/** The literal value LinkedIn writes into a cookie it is killing. */
const TOMBSTONE_VALUE = /^"?delete me"?$/i

const isTombstone = (attributes: string, value: string): boolean =>
  TOMBSTONE_VALUE.test(value.trim()) ||
  /;\s*max-age\s*=\s*0\s*(?:;|$)/i.test(attributes) ||
  /;\s*expires\s*=[^;]*\b19[67]\d\b/i.test(attributes)

const revokedCookieNames = (setCookies: readonly string[]): string[] =>
  setCookies.flatMap((line) => {
    const separator = line.indexOf("=")
    if (separator < 0) return []
    const name = line.slice(0, separator).trim()
    const endOfValue = line.indexOf(";")
    const value = line.slice(separator + 1, endOfValue < 0 ? undefined : endOfValue)
    const attributes = endOfValue < 0 ? "" : line.slice(endOfValue)
    return name && isTombstone(attributes, value) ? [name] : []
  })

export const diagnoseAuthFailure = (
  setCookies: readonly string[],
  location: string | null,
): AuthFailureDiagnosis => {
  const revokedCookies = revokedCookieNames(setCookies)
  // The session cookie being deleted is decisive: whatever the Location says,
  // upstream has thrown the credential away.
  if (revokedCookies.some((name) => name.toLowerCase() === "li_at")) {
    return { kind: "revoked", revokedCookies }
  }
  if (location && /\/checkpoint\//i.test(location)) return { kind: "checkpoint", revokedCookies }
  if (location && /\/uas\/login|\/login\b/i.test(location)) {
    return { kind: "login_wall", revokedCookies }
  }
  return { kind: "unknown", revokedCookies }
}
