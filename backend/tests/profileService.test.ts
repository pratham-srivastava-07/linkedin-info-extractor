
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { env } from "../src/config/env"
import { ProfileService } from "../src/services/profile"
import { SessionManager } from "../src/linkedin/sessionManager"
import { VoyagerClient } from "../src/linkedin/voyagerClient"
import { ExtractionJobRepository } from "../src/repositories/extractionJob.repository"
import { ProfileCacheRepository } from "../src/repositories/profileCache.repository"
import { AppError } from "../src/utils/AppError"
import { SerialQueue } from "../src/utils/serialQueue"
import {
  UpstreamAuthError,
  UpstreamGoneError,
  UpstreamNotFoundError,
  UpstreamRateLimitError,
} from "../src/linkedin/errors"

/**
 * The service is where "the cache is an optimization" either holds or doesn't.
 * Every dependency here is a fake, so a rejection from `cache`/`jobs` stands in
 * for the Postgres outage without needing a database.
 */

const URL = "https://www.linkedin.com/in/jane-doe/"
const PUBLIC_ID = "jane-doe"
/** The dash finder envelope, trimmed to the fields the normalizer needs. */
const RAW = {
  elements: [{ firstName: "Jane", lastName: "Doe", headline: "Engineer" }],
  paging: { total: 1, count: 10, start: 0 },
}

const cookies = { liAt: "AQEDATEST", jsessionId: '"ajax:123"' }

let sessions: { getSession: ReturnType<typeof vi.fn>; invalidateSession: ReturnType<typeof vi.fn> }
let client: { profile: ReturnType<typeof vi.fn> }
let cache: { findFresh: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> }
let jobs: { record: ReturnType<typeof vi.fn> }
let queue: SerialQueue
let logged: ReturnType<typeof vi.spyOn>

const build = () =>
  new ProfileService(
    sessions as unknown as SessionManager,
    client as unknown as VoyagerClient,
    cache as unknown as ProfileCacheRepository,
    jobs as unknown as ExtractionJobRepository,
    queue,
  )

/** Resolves with whatever the call rejected with, so fields can be asserted. */
const rejection = (promise: Promise<unknown>): Promise<any> =>
  promise.then(
    () => {
      throw new Error("expected the call to reject")
    },
    (err) => err,
  )

beforeEach(() => {
  sessions = {
    getSession: vi.fn().mockResolvedValue(cookies),
    invalidateSession: vi.fn().mockResolvedValue(undefined),
  }
  client = { profile: vi.fn().mockResolvedValue(RAW) }
  cache = { findFresh: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) }
  jobs = { record: vi.fn().mockResolvedValue({}) }
  queue = new SerialQueue()
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  logged.mockRestore()
  vi.restoreAllMocks()
})

describe("ProfileService — a database outage must not fail an extraction", () => {
  it("still returns a profile when the cache READ throws", async () => {
    cache.findFresh.mockRejectedValueOnce(new Error("Can't reach database server"))

    const { profile, cacheHit } = await build().extract(URL)

    expect(profile.name).toBe("Jane Doe")
    expect(cacheHit).toBe(false)
    // The extraction still went upstream rather than short-circuiting.
    expect(client.profile).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("[profile_cache] read failed"),
      expect.anything(),
    )
  })

  it("still returns a profile when the cache WRITE throws", async () => {
    cache.upsert.mockRejectedValueOnce(new Error("Can't reach database server"))

    const { profile } = await build().extract(URL)

    expect(profile.name).toBe("Jane Doe")
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("[profile_cache] write failed"),
      expect.anything(),
    )
  })

  it("still returns a profile when the audit-log write throws", async () => {
    jobs.record.mockRejectedValueOnce(new Error("Can't reach database server"))

    await expect(build().extract(URL)).resolves.toMatchObject({ cacheHit: false })
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("[extraction_job]"),
      expect.anything(),
    )
  })

  it("survives cache read, cache write and audit log all failing at once", async () => {
    const down = () => Promise.reject(new Error("Can't reach database server"))
    cache.findFresh.mockImplementation(down)
    cache.upsert.mockImplementation(down)
    jobs.record.mockImplementation(down)

    const { profile } = await build().extract(URL)

    expect(profile.name).toBe("Jane Doe")
  })
})

describe("ProfileService — genuine failures stay loud", () => {
  it.each([
    ["not found", new UpstreamNotFoundError(PUBLIC_ID), "profile_not_found", 404],
    ["rate limited", new UpstreamRateLimitError(45), "rate_limited", 429],
  ])("maps an upstream %s to its documented code even with the database down", async (
    _label,
    upstreamError,
    code,
    status,
  ) => {
    cache.findFresh.mockRejectedValue(new Error("Can't reach database server"))
    jobs.record.mockRejectedValue(new Error("Can't reach database server"))
    client.profile.mockRejectedValue(upstreamError)

    const err = await rejection(build().extract(URL))

    expect(err).toBeInstanceOf(AppError)
    expect(err.code).toBe(code)
    expect(err.statusCode).toBe(status)
  })

  it("raises 502 upstream_schema_mismatch when the payload no longer parses", async () => {
    client.profile.mockResolvedValue({ nothing: "useful" })

    const err = await rejection(build().extract(URL))

    expect(err.code).toBe("upstream_schema_mismatch")
    expect(err.statusCode).toBe(502)
  })

  /**
   * A retired endpoint is a code problem, not a credential problem. Surfacing
   * it as `503 session_unavailable` is what sent this project chasing cookies
   * for hours while `profileView` quietly 410'd, so the two must not share a
   * public code.
   */
  it("raises 502, not 503, when upstream says the endpoint is gone", async () => {
    client.profile.mockRejectedValue(new UpstreamGoneError("/identity/profiles/x/profileView"))

    const err = await rejection(build().extract(URL))

    expect(err.code).toBe("upstream_schema_mismatch")
    expect(err.statusCode).toBe(502)
    expect(err.code).not.toBe("session_unavailable")
    // And it must not have been mistaken for an expired session mid-flight.
    expect(sessions.invalidateSession).not.toHaveBeenCalled()
    expect(client.profile).toHaveBeenCalledTimes(1)
  })
})

describe("ProfileService — the one-retry auth path", () => {
  it("retries exactly once with a revalidated session, then gives up", async () => {
    client.profile.mockRejectedValue(new UpstreamAuthError(401))

    const err = await rejection(build().extract(URL))

    // Two attempts, never a third: a loop here would hammer upstream with dead
    // cookies until the request timed out.
    expect(client.profile).toHaveBeenCalledTimes(2)
    expect(sessions.invalidateSession).toHaveBeenCalledTimes(1)
    expect(sessions.getSession).toHaveBeenCalledTimes(2)
    expect(err.code).toBe("session_unavailable")
    expect(err.statusCode).toBe(503)
  })

  it("succeeds on the retry when the session had merely expired mid-request", async () => {
    client.profile
      .mockRejectedValueOnce(new UpstreamAuthError(401))
      .mockResolvedValueOnce(RAW)

    const { profile } = await build().extract(URL)

    expect(profile.name).toBe("Jane Doe")
    expect(client.profile).toHaveBeenCalledTimes(2)
  })

  it("does not retry a non-auth failure", async () => {
    client.profile.mockRejectedValue(new UpstreamNotFoundError(PUBLIC_ID))

    await rejection(build().extract(URL))

    expect(client.profile).toHaveBeenCalledTimes(1)
    expect(sessions.invalidateSession).not.toHaveBeenCalled()
  })
})

describe("ProfileService — CACHE_TTL_SECONDS", () => {
  it("expires a written entry exactly CACHE_TTL_SECONDS from now", async () => {
    const before = Date.now()
    await build().extract(URL)

    const [publicId, profileUrl, , expiresAt] = cache.upsert.mock.calls[0] as [
      string,
      string,
      unknown,
      Date,
    ]
    expect(publicId).toBe(PUBLIC_ID)
    expect(profileUrl).toBe(URL)
    const ttlMs = expiresAt.getTime() - before
    expect(ttlMs).toBeGreaterThan((env.CACHE_TTL_SECONDS - 1) * 1000)
    expect(ttlMs).toBeLessThanOrEqual(env.CACHE_TTL_SECONDS * 1000 + 5_000)
  })

  it("touches the cache neither for read nor write when set to 0", async () => {
    const original = env.CACHE_TTL_SECONDS
    ;(env as { CACHE_TTL_SECONDS: number }).CACHE_TTL_SECONDS = 0
    try {
      await build().extract(URL)
      expect(cache.findFresh).not.toHaveBeenCalled()
      expect(cache.upsert).not.toHaveBeenCalled()
    } finally {
      ;(env as { CACHE_TTL_SECONDS: number }).CACHE_TTL_SECONDS = original
    }
  })

  it("serves a fresh hit without a session, an upstream call, or the queue", async () => {
    const queued = vi.spyOn(queue, "run")
    cache.findFresh.mockResolvedValueOnce({
      payload: { profileUrl: URL, name: "Cached Jane" },
    })

    const { profile, cacheHit } = await build().extract(URL)

    expect(cacheHit).toBe(true)
    expect(profile.name).toBe("Cached Jane")
    expect(queued).not.toHaveBeenCalled()
    expect(client.profile).not.toHaveBeenCalled()
    expect(sessions.getSession).not.toHaveBeenCalled()
  })
})

describe("ProfileService — the audit log never carries a credential", () => {
  it("records only the public error code and message for a dead session", async () => {
    client.profile.mockRejectedValue(new UpstreamAuthError(401))

    await rejection(build().extract(URL))

    const recorded = JSON.stringify(jobs.record.mock.calls)
    expect(recorded).not.toContain(cookies.liAt)
    expect(recorded).not.toContain("ajax:123")
    expect(jobs.record.mock.calls[0][0]).toMatchObject({
      status: "FAILED",
      errorCode: "session_unavailable",
    })
  })
})
