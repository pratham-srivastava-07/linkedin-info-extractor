import { env } from "../config/env"
import { SessionRepository, sessionRepository } from "../repositories/session.repository"
import { sessionUnavailable } from "../utils/AppError"
import { SessionCookies, fingerprint } from "./cookies"
import { UpstreamAuthError } from "./errors"
import { VoyagerClient, voyagerClient } from "./voyagerClient"

export interface SessionState {
  valid: boolean
  memberUrn: string | null
  lastValidatedAt: Date | null
  expiresAt: Date | null
  lastError: string | null
}

/**
 * Owns the authenticated context used to reach upstream.
 *
 * Credentials come from env (own-credentials model, CLAUDE.md) rather than a
 * scripted login: no browser is involved, and a password flow would trip
 * LinkedIn's checkpoint/CAPTCHA from a server IP. What lives in Postgres is only
 * *validation state* — how recently these cookies were proven to work — so we
 * re-check upstream at most once per SESSION_TTL_SECONDS instead of on every call.
 */
/**
 * How long a *failed* validation is remembered before we probe upstream again.
 *
 * Without this, one dead cookie turns every `/health` poll into a `GET /me`
 * against LinkedIn — and `/health` is unauthenticated, so the rate is set by
 * whoever is calling it, not by us. docs/notes.md records that "too many requests
 * too quickly" is exactly what earns an HTTP 999, so the failure path must be
 * self-limiting. Recovery is not delayed by it: new cookies arrive in the
 * environment, which means a restart, which clears this.
 */
export const FAILED_VALIDATION_BACKOFF_MS = 30_000

interface CachedVerdict {
  fingerprint: string
  valid: boolean
  until: number
}

export class SessionManager {
  private inFlight: Promise<SessionCookies> | null = null
  /**
   * In-process memory of the last verdict on these cookies.
   *
   * The Postgres row is the same fact, but survives a restart; this one survives
   * a *database outage*. Postgres being down must cost us the shortcut, not
   * turn every request into an extra upstream call — the outage behaviour the
   * cache path already promises in services/profile.ts.
   */
  private verdict: CachedVerdict | null = null

  constructor(
    private readonly repo: SessionRepository,
    private readonly client: VoyagerClient,
  ) {}

  private get cookies(): SessionCookies {
    // A full captured header wins when present; the two-cookie pair stays as the
    // fallback so setups predating LINKEDIN_COOKIE keep working. `config/env`
    // has already rejected a configuration with neither.
    const raw = env.LINKEDIN_COOKIE.trim()
    return raw ? { raw } : { liAt: env.LINKEDIN_LI_AT, jsessionId: env.LINKEDIN_JSESSIONID }
  }

  /** Throws `session_unavailable` (503) when the configured cookies are dead. */
  async getSession(): Promise<SessionCookies> {
    const fp = fingerprint(this.cookies)

    const remembered = this.rememberedVerdict(fp)
    if (remembered === true) return this.cookies
    // A recent failure is answered without another upstream round trip. The
    // cookies did not heal in the last few seconds, and asking again is the
    // behaviour that gets an account flagged.
    if (remembered === false) throw sessionUnavailable(new Error("Session was rejected upstream"))

    if (await this.isStillTrusted(fp)) return this.cookies

    // Collapse concurrent revalidations into one upstream call.
    this.inFlight ??= this.validate(fp).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** The in-process verdict, or null when there isn't a fresh one for these cookies. */
  private rememberedVerdict(fp: string): boolean | null {
    const cached = this.verdict
    if (!cached || cached.fingerprint !== fp || cached.until <= Date.now()) return null
    return cached.valid
  }

  private remember(fp: string, valid: boolean, ttlMs: number): void {
    this.verdict = { fingerprint: fp, valid, until: Date.now() + ttlMs }
  }

  /**
   * The stored validation state is a cache of "these cookies worked recently", so
   * losing Postgres must cost us the shortcut, not the request: an unreadable
   * record is treated as "not known yet" and we pay one extra upstream `/me`.
   */
  private async isStillTrusted(fp: string): Promise<boolean> {
    try {
      const known = await this.repo.findByFingerprint(fp)
      const trusted = known?.status === "ACTIVE" && known.expiresAt.getTime() > Date.now()
      // Mirror a database hit into memory so the row is read once per TTL, not
      // once per request.
      if (trusted && known) this.remember(fp, true, known.expiresAt.getTime() - Date.now())
      return trusted
    } catch (err) {
      console.error("[session] could not read validation state, revalidating upstream", err)
      return false
    }
  }

  private async validate(fp: string): Promise<SessionCookies> {
    let me: Awaited<ReturnType<VoyagerClient["me"]>>
    try {
      me = await this.client.me(this.cookies)
    } catch (err) {
      this.remember(fp, false, Math.min(FAILED_VALIDATION_BACKOFF_MS, env.SESSION_TTL_SECONDS * 1000))
      // Only upstream's verdict lands here, so `reason` can never carry a driver
      // message (or the DATABASE_URL inside one) into the sessions table.
      const reason = err instanceof Error ? err.message : "Session validation failed"
      await this.markExpired(fp, reason.slice(0, 500))
      throw sessionUnavailable(err)
    }

    // Recording the success is bookkeeping: if it fails, the cookies are still
    // good and the request should still go through — we just re-check next time.
    const memberUrn = me["*miniProfile"] ?? (me.plainId != null ? String(me.plainId) : null)
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000)
    this.remember(fp, true, env.SESSION_TTL_SECONDS * 1000)
    try {
      await this.repo.markValidated(fp, memberUrn, expiresAt)
    } catch (err) {
      console.error("[session] could not persist validation state, continuing", err)
    }
    return this.cookies
  }

  private async markExpired(fp: string, reason: string): Promise<void> {
    try {
      await this.repo.markExpired(fp, reason)
    } catch (err) {
      console.error("[session] could not persist expiry state", err)
    }
  }

  /**
   * Drops our trust in the current cookies so the next call revalidates. Called
   * when a request fails mid-flight with an auth error — the session may have
   * expired between validation and use.
   */
  async invalidateSession(reason = "Invalidated after an upstream auth failure"): Promise<void> {
    // Dropped, not remembered as a failure: this is the mid-request expiry path,
    // and the single retry that follows must be allowed to probe upstream.
    this.verdict = null
    await this.markExpired(fingerprint(this.cookies), reason.slice(0, 500))
  }

  /** Read-only view for /health. Never triggers a revalidation. */
  async describe(): Promise<SessionState> {
    const known = await this.repo.findByFingerprint(fingerprint(this.cookies))
    if (!known) {
      return { valid: false, memberUrn: null, lastValidatedAt: null, expiresAt: null, lastError: null }
    }
    return {
      valid: known.status === "ACTIVE" && known.expiresAt.getTime() > Date.now(),
      memberUrn: known.memberUrn,
      lastValidatedAt: known.lastValidatedAt,
      expiresAt: known.expiresAt,
      lastError: known.lastError,
    }
  }

  /** True when the cookies work right now — used by /health readiness. */
  async probe(): Promise<boolean> {
    try {
      await this.getSession()
      return true
    } catch {
      return false
    }
  }

  isAuthFailure(err: unknown): err is UpstreamAuthError {
    return err instanceof UpstreamAuthError
  }
}

export const sessionManager = new SessionManager(sessionRepository, voyagerClient)
