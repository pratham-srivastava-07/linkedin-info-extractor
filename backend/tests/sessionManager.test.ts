import { Session } from "@prisma/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { env } from "../src/config/env"
import { SessionManager, FAILED_VALIDATION_BACKOFF_MS } from "../src/linkedin/sessionManager"
import { SessionRepository } from "../src/repositories/session.repository"
import { UpstreamAuthError } from "../src/linkedin/errors"
import { VoyagerClient } from "../src/linkedin/voyagerClient"
import { fingerprint } from "../src/linkedin/cookies"
import { AppError } from "../src/utils/AppError"

/**
 * The session manager is the only component that can decide to make an extra
 * call to LinkedIn, and docs/notes.md records that "too many requests too
 * quickly" is what earns an HTTP 999 on the account. So the assertions here are
 * mostly counts: how many times did we actually reach upstream?
 */

const activeRow = (expiresAt: Date): Session =>
  ({
    id: "s1",
    fingerprint: fingerprint({ liAt: env.LINKEDIN_LI_AT, jsessionId: env.LINKEDIN_JSESSIONID }),
    status: "ACTIVE",
    memberUrn: "urn:li:fs_miniProfile:abc",
    lastValidatedAt: new Date(),
    expiresAt,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as Session

const build = () => {
  const findByFingerprint = vi.fn<SessionRepository["findByFingerprint"]>().mockResolvedValue(null)
  const markValidated = vi.fn<SessionRepository["markValidated"]>().mockResolvedValue({} as Session)
  const markExpired = vi.fn<SessionRepository["markExpired"]>().mockResolvedValue({} as Session)
  const me = vi.fn<VoyagerClient["me"]>().mockResolvedValue({ plainId: 42 })

  const repo = { findByFingerprint, markValidated, markExpired } as unknown as SessionRepository
  const client = { me } as unknown as VoyagerClient
  return { manager: new SessionManager(repo, client), findByFingerprint, markValidated, markExpired, me }
}

let logged: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  logged.mockRestore()
  vi.useRealTimers()
})

describe("SESSION_TTL_SECONDS is honoured", () => {
  it("trusts a stored row that has not expired, without calling upstream", async () => {
    const { manager, findByFingerprint, me } = build()
    findByFingerprint.mockResolvedValue(activeRow(new Date(Date.now() + 60_000)))

    await manager.getSession()

    expect(me).not.toHaveBeenCalled()
    expect(findByFingerprint).toHaveBeenCalledOnce()
  })

  it("revalidates once the stored row has aged past its expiry", async () => {
    const { manager, findByFingerprint, me } = build()
    findByFingerprint.mockResolvedValue(activeRow(new Date(Date.now() - 1)))

    await manager.getSession()

    expect(me).toHaveBeenCalledOnce()
  })

  it("stores an expiry exactly SESSION_TTL_SECONDS ahead", async () => {
    vi.useFakeTimers()
    const now = new Date("2026-08-30T10:00:00.000Z")
    vi.setSystemTime(now)
    const { manager, markValidated } = build()

    await manager.getSession()

    const [, , expiresAt] = markValidated.mock.calls[0]
    expect(expiresAt.getTime()).toBe(now.getTime() + env.SESSION_TTL_SECONDS * 1000)
  })

  it("does not re-read the database on every call inside the TTL", async () => {
    const { manager, findByFingerprint, me } = build()
    findByFingerprint.mockResolvedValue(activeRow(new Date(Date.now() + 60_000)))

    await manager.getSession()
    await manager.getSession()
    await manager.getSession()

    expect(findByFingerprint).toHaveBeenCalledOnce()
    expect(me).not.toHaveBeenCalled()
  })
})

describe("a rotated cookie invalidates the cached validation state", () => {
  it("looks up the new fingerprint, so the old ACTIVE row cannot answer for it", async () => {
    const { manager, findByFingerprint } = build()
    findByFingerprint.mockResolvedValue(activeRow(new Date(Date.now() + 60_000)))
    await manager.getSession()

    const before = findByFingerprint.mock.calls[0][0]
    // The operator pastes a fresh JSESSIONID — li_at unchanged.
    env.LINKEDIN_JSESSIONID = '"ajax:1111111111111111111"'
    findByFingerprint.mockResolvedValue(null)

    await manager.getSession()

    expect(findByFingerprint.mock.calls[1][0]).not.toBe(before)
    env.LINKEDIN_JSESSIONID = '"ajax:0000000000000000000"'
  })

  it("does not let the in-memory verdict for one cookie set answer for another", async () => {
    const { manager, me } = build()
    await manager.getSession()
    expect(me).toHaveBeenCalledOnce()

    env.LINKEDIN_LI_AT = "AQEDA-a-rotated-cookie"
    await manager.getSession()

    // The rotation is a different session; it has to be proven on its own.
    expect(me).toHaveBeenCalledTimes(2)
    env.LINKEDIN_LI_AT = "test-li-at"
  })
})

describe("a Postgres outage must not turn into upstream traffic", () => {
  it("validates once and then serves from memory while the database is down", async () => {
    const { manager, findByFingerprint, me } = build()
    findByFingerprint.mockRejectedValue(new Error("Can't reach database server at localhost:5432"))

    await manager.getSession()
    await manager.getSession()
    await manager.getSession()

    // Before the in-process verdict existed this was three `/me` calls.
    expect(me).toHaveBeenCalledOnce()
  })

  it("still serves the request when the database cannot be read at all", async () => {
    const { manager, findByFingerprint } = build()
    findByFingerprint.mockRejectedValue(new Error("db down"))

    await expect(manager.getSession()).resolves.toEqual({
      liAt: env.LINKEDIN_LI_AT,
      jsessionId: env.LINKEDIN_JSESSIONID,
    })
  })

  it("still serves the request when the validation state cannot be written", async () => {
    const { manager, markValidated } = build()
    markValidated.mockRejectedValue(new Error("db down"))

    await expect(manager.getSession()).resolves.toBeTruthy()
  })
})

describe("a dead cookie is not re-probed on every call", () => {
  it("backs off instead of hitting upstream once per unauthenticated /health poll", async () => {
    const { manager, me } = build()
    me.mockRejectedValue(new UpstreamAuthError(401))

    for (let i = 0; i < 5; i += 1) await manager.probe()

    expect(me).toHaveBeenCalledOnce()
  })

  it("reports the failure as session_unavailable every time, not just the first", async () => {
    const { manager, me } = build()
    me.mockRejectedValue(new UpstreamAuthError(401))

    await expect(manager.getSession()).rejects.toMatchObject({ code: "session_unavailable" })
    await expect(manager.getSession()).rejects.toMatchObject({ code: "session_unavailable" })
  })

  it("re-probes once the backoff window has passed", async () => {
    vi.useFakeTimers()
    const { manager, me } = build()
    me.mockRejectedValue(new UpstreamAuthError(401))

    await manager.probe()
    vi.setSystemTime(Date.now() + FAILED_VALIDATION_BACKOFF_MS + 1)
    await manager.probe()

    expect(me).toHaveBeenCalledTimes(2)
  })

  it("never leaks a cookie into the error it throws", async () => {
    const { manager, me } = build()
    me.mockRejectedValue(new UpstreamAuthError(401))

    const err = (await manager.getSession().catch((e) => e)) as AppError
    expect(err.publicMessage).toBeUndefined()
    expect(JSON.stringify({ message: err.message, cause: String(err.cause) })).not.toContain(
      env.LINKEDIN_LI_AT,
    )
  })

  it("records only upstream's own verdict as lastError, never a driver message", async () => {
    const { manager, me, markExpired } = build()
    me.mockRejectedValue(new UpstreamAuthError(403))

    await manager.probe()

    const [, lastError] = markExpired.mock.calls[0]
    expect(lastError).toBe("Upstream rejected the session (HTTP 403)")
    expect(lastError).not.toContain(env.LINKEDIN_LI_AT)
  })
})

describe("invalidateSession keeps the one-retry path working", () => {
  it("drops the remembered verdict so the retry actually re-probes", async () => {
    const { manager, me } = build()
    await manager.getSession()
    expect(me).toHaveBeenCalledOnce()

    await manager.invalidateSession("Auth failure during extraction")
    await manager.getSession()

    expect(me).toHaveBeenCalledTimes(2)
  })

  it("cannot loop: a retry whose revalidation also fails throws instead of probing again", async () => {
    const { manager, me } = build()
    await manager.getSession()

    await manager.invalidateSession()
    me.mockRejectedValue(new UpstreamAuthError(401))
    await expect(manager.getSession()).rejects.toMatchObject({ code: "session_unavailable" })

    // Two upstream calls total — the original validation and the single retry.
    expect(me).toHaveBeenCalledTimes(2)
  })

  it("survives a database that cannot record the invalidation", async () => {
    const { manager, markExpired } = build()
    markExpired.mockRejectedValue(new Error("db down"))

    await expect(manager.invalidateSession()).resolves.toBeUndefined()
  })
})

describe("concurrent callers", () => {
  it("collapse into a single upstream validation", async () => {
    const { manager, me } = build()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    me.mockImplementation(async () => {
      await gate
      return { plainId: 42 }
    })

    const all = Promise.all([manager.getSession(), manager.getSession(), manager.getSession()])
    release()
    await all

    expect(me).toHaveBeenCalledOnce()
  })
})
