import { env } from "../config/env"
import { DashProfileResponse, VoyagerMe } from "../interfaces/linkedin"
import { SessionCookies } from "./cookies"
import { VOYAGER_BASE, voyagerHeaders } from "./headers"
import {
  UpstreamAuthError,
  UpstreamGoneError,
  UpstreamNotFoundError,
  UpstreamRateLimitError,
  UpstreamUnavailableError,
} from "./errors"

/**
 * Direct HTTP client for LinkedIn's internal Voyager API.
 *
 * No browser anywhere in this path: we speak the same requests the web client
 * makes, carrying the operator's session cookies and the derived CSRF token.
 */

/**
 * The exception class upstream uses for "this profile is not yours to read".
 *
 * It arrives as an HTTP **403**, not a 404 — the dash profiles finder never
 * 404s. Both a private/out-of-network profile and a public id that does not
 * exist at all come back as:
 *
 *   403 {"exceptionClass":"com.linkedin.voyager.common.VoyagerUserVisibleException",
 *        "message":"This profile can't be accessed","status":403}
 *
 * That has to be told apart from a real 403, which means the session or the
 * CSRF token was rejected. Reading one profile the session cannot see must not
 * invalidate the session and 503 the whole service.
 */
const USER_VISIBLE_EXCEPTION = "com.linkedin.voyager.common.VoyagerUserVisibleException"

const isProfileAccessDenial = (body: string): boolean => {
  try {
    const parsed = JSON.parse(body) as { exceptionClass?: unknown }
    return parsed?.exceptionClass === USER_VISIBLE_EXCEPTION
  } catch {
    // A 403 with a non-JSON body is the CSRF/session case.
    return false
  }
}

export class VoyagerClient {
  private async get<T>(path: string, cookies: SessionCookies, publicId?: string): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${VOYAGER_BASE}${path}`, {
        headers: voyagerHeaders(cookies),
        redirect: "manual",
        signal: AbortSignal.timeout(env.UPSTREAM_TIMEOUT_MS),
      })
    } catch (cause) {
      throw new UpstreamUnavailableError("Could not reach LinkedIn", { cause })
    }

    // A redirect to the login wall is how an expired cookie usually presents — it
    // arrives as a 3xx, not a 401. Voyager has no legitimate redirect for these
    // reads, so treating the whole range as an auth failure is what lets the
    // service retry once with a revalidated session.
    if (response.status >= 300 && response.status < 400) throw new UpstreamAuthError(401)

    // 403 is overloaded: it is both "your session is bad" and "that profile is
    // not visible to you". Only the body tells them apart, and getting it wrong
    // costs either a false 404 or a needlessly invalidated session.
    if (response.status === 403) {
      const body = await response.text().catch(() => "")
      if (isProfileAccessDenial(body)) throw new UpstreamNotFoundError(publicId ?? path)
      throw new UpstreamAuthError(403)
    }
    if (response.status === 401) throw new UpstreamAuthError(response.status)
    if (response.status === 404) throw new UpstreamNotFoundError(publicId ?? path)
    // A retired endpoint, not a dead session — see UpstreamGoneError.
    if (response.status === 410) throw new UpstreamGoneError(path)
    // 999 is LinkedIn's own "you look automated" response.
    if (response.status === 429 || response.status === 999) {
      const retryAfter = Number(response.headers.get("retry-after"))
      throw new UpstreamRateLimitError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30)
    }
    if (!response.ok) {
      throw new UpstreamUnavailableError(`Upstream returned HTTP ${response.status}`)
    }

    try {
      return (await response.json()) as T
    } catch (cause) {
      throw new UpstreamUnavailableError("Upstream returned a non-JSON body", { cause })
    }
  }

  /** Cheapest possible liveness check for a session. */
  me(cookies: SessionCookies): Promise<VoyagerMe> {
    return this.get<VoyagerMe>("/me", cookies)
  }

  /**
   * The whole profile in one round trip.
   *
   * `identity/dash/profiles` is a restli *finder*, so the profile comes back
   * wrapped in `elements` even though exactly one is ever matched. The
   * decoration is what makes this a single request: the default projection
   * returns only the top card, with `experienceCard`/`educationCard` as bare
   * urn references, whereas `FullProfileWithEntities` inlines positions,
   * education, skills, certifications and languages alongside the summary.
   *
   * The decoration's version suffix rotates the same way a GraphQL `queryId`
   * hash does, so it is configuration (`LINKEDIN_PROFILE_DECORATION_ID`), not a
   * constant baked into this signature. When upstream retires the current one,
   * that is a value to change in the environment, not a redeploy.
   */
  async profile(publicId: string, cookies: SessionCookies): Promise<DashProfileResponse> {
    const query = new URLSearchParams({
      q: "memberIdentity",
      memberIdentity: publicId,
      decorationId: env.LINKEDIN_PROFILE_DECORATION_ID,
    })
    const response = await this.get<DashProfileResponse>(
      `/identity/dash/profiles?${query.toString()}`,
      cookies,
      publicId,
    )

    // A finder that matched nothing is a missing profile, not a broken schema —
    // classify it here so the normalizer never has to decide, and the caller
    // gets 404 rather than 502.
    if (Array.isArray(response?.elements) && response.elements.length === 0) {
      throw new UpstreamNotFoundError(publicId)
    }

    return response
  }
}

export const voyagerClient = new VoyagerClient()
