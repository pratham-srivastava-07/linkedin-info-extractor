import { JobStatus } from "@prisma/client"
import { env } from "../config/env"
import { SessionManager, sessionManager } from "../linkedin/sessionManager"
import {
  UpstreamAuthError,
  UpstreamGoneError,
  UpstreamNotFoundError,
  UpstreamRateLimitError,
  UpstreamUnavailableError,
} from "../linkedin/errors"
import { VoyagerClient, voyagerClient } from "../linkedin/voyagerClient"
import { Profile } from "../interfaces/profile"
import { normalizeProfile } from "../normalization/normalizeProfile"
import {
  ExtractionJobRepository,
  extractionJobRepository,
} from "../repositories/extractionJob.repository"
import {
  ProfileCacheRepository,
  profileCacheRepository,
} from "../repositories/profileCache.repository"
import { AppError, profileNotFound, rateLimited, sessionUnavailable } from "../utils/AppError"
import { SerialQueue } from "../utils/serialQueue"
import { parseProfileUrl } from "../validators"

export interface ExtractionResult {
  profile: Profile
  cacheHit: boolean
}

export class ProfileService {
  constructor(
    private readonly sessions: SessionManager,
    private readonly client: VoyagerClient,
    private readonly cache: ProfileCacheRepository,
    private readonly jobs: ExtractionJobRepository,
    private readonly queue: SerialQueue,
  ) {}

  async extract(rawUrl: string): Promise<ExtractionResult> {
    // Throws invalid_url (400) before anything touches the network.
    const { publicId, canonicalUrl } = parseProfileUrl(rawUrl)
    const startedAt = Date.now()

    // Cache hits bypass the queue entirely — they cost us no upstream throughput.
    const cached = await this.readCache(publicId)
    if (cached) {
      await this.recordSuccess(canonicalUrl, publicId, true, Date.now() - startedAt)
      return { profile: cached, cacheHit: true }
    }

    try {
      const profile = await this.queue.run(() => this.fetchAndNormalize(publicId, canonicalUrl))
      await this.writeCache(publicId, canonicalUrl, profile)
      await this.recordSuccess(canonicalUrl, publicId, false, Date.now() - startedAt)
      return { profile, cacheHit: false }
    } catch (err) {
      const appError = this.toPublicError(err)
      await this.recordFailure(canonicalUrl, publicId, appError, Date.now() - startedAt)
      throw appError
    }
  }

  /**
   * The cache is an optimization, so its I/O is never allowed to decide the
   * outcome of a request: a Postgres outage costs us the cache, not the
   * extraction ("resilience over cleverness", CLAUDE.md). Same contract as the
   * audit-log writes below — swallow, but always log.
   */
  private async readCache(publicId: string): Promise<Profile | null> {
    if (env.CACHE_TTL_SECONDS <= 0) return null
    try {
      const hit = await this.cache.findFresh(publicId)
      return hit ? (hit.payload as unknown as Profile) : null
    } catch (err) {
      console.error("[profile_cache] read failed, continuing uncached", err)
      return null
    }
  }

  private async writeCache(publicId: string, profileUrl: string, profile: Profile): Promise<void> {
    if (env.CACHE_TTL_SECONDS <= 0) return
    try {
      const expiresAt = new Date(Date.now() + env.CACHE_TTL_SECONDS * 1000)
      await this.cache.upsert(publicId, profileUrl, profile, expiresAt)
    } catch (err) {
      console.error("[profile_cache] write failed, result not cached", err)
    }
  }

  private async fetchAndNormalize(publicId: string, profileUrl: string): Promise<Profile> {
    const raw = await this.fetchWithSessionRetry(publicId)
    // Pure from here down — no I/O inside the normalizer.
    return normalizeProfile(raw, { profileUrl, fetchedAt: new Date() })
  }

  /**
   * A session can expire between validation and use, so an auth failure buys
   * exactly one retry with a revalidated session before we give up — the
   * "session expired mid-request" row of the failure table in
   * docs/architecture.md. One retry, not a loop: if fresh cookies also fail, the
   * cookies themselves are dead and retrying just burns requests.
   */
  private async fetchWithSessionRetry(publicId: string) {
    const cookies = await this.sessions.getSession()
    try {
      return await this.client.profile(publicId, cookies)
    } catch (err) {
      if (!(err instanceof UpstreamAuthError)) throw err
      await this.sessions.invalidateSession("Auth failure during extraction")
      const refreshed = await this.sessions.getSession()
      return this.client.profile(publicId, refreshed)
    }
  }

  /** Translates transport-layer signals into the api.md error vocabulary. */
  private toPublicError(err: unknown): AppError {
    if (err instanceof AppError) return err
    if (err instanceof UpstreamNotFoundError) return profileNotFound()
    if (err instanceof UpstreamRateLimitError) return rateLimited(err.retryAfterSeconds)
    // A retired endpoint is upstream drift we have to fix in code, so it takes
    // the same 502 as a changed payload shape — deliberately NOT the 503 that
    // means "your cookies are dead", which is what it used to be mistaken for.
    if (err instanceof UpstreamGoneError)
      return new AppError("upstream_schema_mismatch", 502, { cause: err })
    if (err instanceof UpstreamAuthError) return sessionUnavailable(err)
    if (err instanceof UpstreamUnavailableError) return sessionUnavailable(err)
    return new AppError("internal_error", 500, {
      publicMessage: "Something went wrong. Please try again",
      cause: err,
    })
  }

  private recordSuccess(profileUrl: string, publicId: string, cacheHit: boolean, durationMs: number) {
    // The audit log must never be the reason a good extraction fails.
    return this.jobs
      .record({ profileUrl, publicId, status: JobStatus.SUCCEEDED, cacheHit, durationMs })
      .then(() => undefined)
      .catch((err) => console.error("[extraction_job] failed to record success", err))
  }

  private recordFailure(profileUrl: string, publicId: string, error: AppError, durationMs: number) {
    return this.jobs
      .record({
        profileUrl,
        publicId,
        status: JobStatus.FAILED,
        cacheHit: false,
        durationMs,
        errorCode: error.code,
        errorMessage: error.message.slice(0, 500),
      })
      .then(() => undefined)
      .catch((err) => console.error("[extraction_job] failed to record failure", err))
  }
}

export const profileService = new ProfileService(
  sessionManager,
  voyagerClient,
  profileCacheRepository,
  extractionJobRepository,
  new SerialQueue(),
)
