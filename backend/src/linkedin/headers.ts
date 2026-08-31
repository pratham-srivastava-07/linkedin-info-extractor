import { SessionCookies, cookieHeaderFrom, csrfTokenFor } from "./cookies"

export const VOYAGER_BASE = "https://www.linkedin.com/voyager/api"

/**
 * A desktop UA is required — Voyager answers unrecognised agents with 999.
 * Kept as a constant so there is one place to refresh it when it ages out, and
 * used whenever `LINKEDIN_USER_AGENT` is not set.
 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/**
 * Tracking headers a real web client sends on every Voyager call. They are read
 * from `process.env` rather than `config/env` because this module has to stay
 * importable by `scripts/check-session.ts`, which must run before DATABASE_URL
 * exists. Read per call so a test (or a `.env` reload) is picked up.
 *
 * Only sent when captured: a wrong or stale `x-li-track` is worse than none, and
 * these values are specific to the browser session they came from.
 */
const trackingHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {}
  const track = process.env.LINKEDIN_X_LI_TRACK?.trim()
  const pageInstance = process.env.LINKEDIN_X_LI_PAGE_INSTANCE?.trim()
  if (track) headers["x-li-track"] = track
  if (pageInstance) headers["x-li-page-instance"] = pageInstance
  return headers
}

/**
 * The exact header set the Voyager client puts on the wire.
 *
 * Lives apart from `voyagerClient.ts` so `scripts/check-session.ts` can send
 * byte-identical requests without importing `config/env` — the whole point of
 * that script is to work when the rest of the environment isn't configured yet.
 * Sharing it also means a cookie that passes the check cannot fail in the service
 * because of a header that drifted between the two.
 */
export const voyagerHeaders = (cookies: SessionCookies): Record<string, string> => ({
  cookie: cookieHeaderFrom(cookies),
  "csrf-token": csrfTokenFor(cookies),
  accept: "application/json",
  "accept-language": "en-US,en;q=0.9",
  "x-restli-protocol-version": "2.0.0",
  "x-li-lang": "en_US",
  "user-agent": process.env.LINKEDIN_USER_AGENT?.trim() || USER_AGENT,
  referer: "https://www.linkedin.com/feed/",
  ...trackingHeaders(),
})
