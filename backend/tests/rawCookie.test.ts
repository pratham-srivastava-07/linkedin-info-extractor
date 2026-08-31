import { Session } from "@prisma/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { env, envSchema } from "../src/config/env"
import {
  cookieHeaderFrom,
  csrfTokenFor,
  fingerprint,
  jsessionIdFrom,
} from "../src/linkedin/cookies"
import { USER_AGENT, voyagerHeaders } from "../src/linkedin/headers"
import { SessionManager } from "../src/linkedin/sessionManager"
import { VoyagerClient } from "../src/linkedin/voyagerClient"
import { SessionRepository } from "../src/repositories/session.repository"

/**
 * The captured-cookie path. Sending only li_at + JSESSIONID got a session
 * actively revoked (docs/notes.md), so LINKEDIN_COOKIE carries a whole real
 * cookie header instead. These assert the three things that can silently break:
 * the header must go out byte-for-byte, the csrf-token must still be derived
 * from JSESSIONID inside it, and swapping the capture must change the
 * fingerprint so a stale "validated" row cannot answer for it.
 */

const RAW =
  'bcookie="v=2&abc123"; bscookie="v=1&xyz"; li_gc=MTs...; lidc="b=OGST00:g=1234"; ' +
  'liap=true; JSESSIONID="ajax:9876543210"; li_at=AQEDATEST'

const TRACKING_VARS = [
  "LINKEDIN_USER_AGENT",
  "LINKEDIN_X_LI_TRACK",
  "LINKEDIN_X_LI_PAGE_INSTANCE",
] as const

beforeEach(() => {
  for (const name of TRACKING_VARS) delete process.env[name]
})
afterEach(() => {
  for (const name of TRACKING_VARS) delete process.env[name]
  vi.unstubAllGlobals()
})

describe("a raw captured cookie header", () => {
  it("is sent verbatim, not rebuilt from parts", () => {
    expect(cookieHeaderFrom({ raw: RAW })).toBe(RAW)
    // Whitespace from the paste is the only thing touched.
    expect(cookieHeaderFrom({ raw: `  ${RAW}\n` })).toBe(RAW)
  })

  it("still derives the csrf-token from the JSESSIONID inside it", () => {
    expect(csrfTokenFor({ raw: RAW })).toBe("ajax:9876543210")
  })

  it.each([
    ['JSESSIONID="ajax:123"; li_at=AQ', "ajax:123"],
    ["li_at=AQ; JSESSIONID=ajax:123", "ajax:123"],
    ["li_at=AQ; JSESSIONID=ajax:123; lidc=x", "ajax:123"],
    ['li_at=AQ;JSESSIONID="ajax:123";lidc=x', "ajax:123"],
    ['li_at=AQ; jsessionid="ajax:123"', "ajax:123"],
  ])("finds JSESSIONID in %s", (raw, expected) => {
    expect(csrfTokenFor({ raw })).toBe(expected)
    expect(jsessionIdFrom(raw)).not.toBeNull()
  })

  it("reports no JSESSIONID rather than inventing one", () => {
    expect(jsessionIdFrom("li_at=AQ; lidc=x")).toBeNull()
    // A cookie named *like* JSESSIONID must not be mistaken for it.
    expect(jsessionIdFrom("li_at=AQ; NOTJSESSIONID=nope")).toBeNull()
  })

  it("does not mistake JSESSIONID inside another cookie's value for the real one", () => {
    expect(jsessionIdFrom('bcookie="JSESSIONID=fake"')).toBeNull()
  })
})

describe("the fingerprint follows what is actually sent", () => {
  it("is stable for the same capture", () => {
    expect(fingerprint({ raw: RAW })).toBe(fingerprint({ raw: `${RAW} ` }))
  })

  it("changes when any cookie in the set changes", () => {
    const rotated = RAW.replace("lidc=\"b=OGST00:g=1234\"", 'lidc="b=OGST00:g=9999"')
    expect(rotated).not.toBe(RAW)
    expect(fingerprint({ raw: rotated })).not.toBe(fingerprint({ raw: RAW }))
  })

  it("separates a captured header from the two-cookie pair carrying the same session", () => {
    const pair = fingerprint({ liAt: "AQEDATEST", jsessionId: '"ajax:9876543210"' })
    expect(fingerprint({ raw: RAW })).not.toBe(pair)
  })

  it("still changes on a rotated JSESSIONID in the fallback pair", () => {
    const before = fingerprint({ liAt: "AQEDATEST", jsessionId: '"ajax:1111"' })
    const after = fingerprint({ liAt: "AQEDATEST", jsessionId: '"ajax:2222"' })
    expect(after).not.toBe(before)
  })
})

describe("voyagerHeaders", () => {
  it("carries the raw header and its derived csrf token", () => {
    const headers = voyagerHeaders({ raw: RAW })
    expect(headers.cookie).toBe(RAW)
    expect(headers["csrf-token"]).toBe("ajax:9876543210")
    expect(headers["x-restli-protocol-version"]).toBe("2.0.0")
  })

  it("omits the tracking headers when they were not captured", () => {
    const headers = voyagerHeaders({ raw: RAW })
    expect(headers).not.toHaveProperty("x-li-track")
    expect(headers).not.toHaveProperty("x-li-page-instance")
    expect(headers["user-agent"]).toBe(USER_AGENT)
  })

  it("sends the tracking headers when they are configured", () => {
    process.env.LINKEDIN_X_LI_TRACK = '{"clientVersion":"1.13.1"}'
    process.env.LINKEDIN_X_LI_PAGE_INSTANCE = "urn:li:page:d_flagship3_profile_view_base;abc"
    process.env.LINKEDIN_USER_AGENT = "Mozilla/5.0 (Macintosh) Chrome/140.0.0.0"

    const headers = voyagerHeaders({ raw: RAW })

    expect(headers["x-li-track"]).toBe('{"clientVersion":"1.13.1"}')
    expect(headers["x-li-page-instance"]).toBe("urn:li:page:d_flagship3_profile_view_base;abc")
    expect(headers["user-agent"]).toBe("Mozilla/5.0 (Macintosh) Chrome/140.0.0.0")
  })

  it("falls back to the built-in user agent when the env var is blank", () => {
    process.env.LINKEDIN_USER_AGENT = "   "
    expect(voyagerHeaders({ raw: RAW })["user-agent"]).toBe(USER_AGENT)
  })
})

describe("VoyagerClient with a captured header", () => {
  it("puts it on the wire unchanged", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ profile: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    vi.stubGlobal("fetch", fetchSpy)

    await new VoyagerClient().profileView("jane-doe", { raw: RAW })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.cookie).toBe(RAW)
    expect(headers["csrf-token"]).toBe("ajax:9876543210")
  })
})

describe("SessionManager credential selection", () => {
  const build = () => {
    const findByFingerprint = vi
      .fn<SessionRepository["findByFingerprint"]>()
      .mockResolvedValue(null)
    const markValidated = vi
      .fn<SessionRepository["markValidated"]>()
      .mockResolvedValue({} as Session)
    const markExpired = vi.fn<SessionRepository["markExpired"]>().mockResolvedValue({} as Session)
    const me = vi.fn<VoyagerClient["me"]>().mockResolvedValue({ plainId: 42 })
    const repo = { findByFingerprint, markValidated, markExpired } as unknown as SessionRepository
    return {
      manager: new SessionManager(repo, { me } as unknown as VoyagerClient),
      findByFingerprint,
      markValidated,
    }
  }

  afterEach(() => {
    env.LINKEDIN_COOKIE = ""
  })

  it("uses LINKEDIN_COOKIE verbatim when it is set", async () => {
    env.LINKEDIN_COOKIE = RAW
    const { manager, markValidated } = build()

    await expect(manager.getSession()).resolves.toEqual({ raw: RAW })
    expect(markValidated.mock.calls[0][0]).toBe(fingerprint({ raw: RAW }))
  })

  it("falls back to the li_at + JSESSIONID pair when it is not", async () => {
    const { manager, markValidated } = build()

    await expect(manager.getSession()).resolves.toEqual({
      liAt: env.LINKEDIN_LI_AT,
      jsessionId: env.LINKEDIN_JSESSIONID,
    })
    expect(markValidated.mock.calls[0][0]).toBe(
      fingerprint({ liAt: env.LINKEDIN_LI_AT, jsessionId: env.LINKEDIN_JSESSIONID }),
    )
  })

  it("does not let a verdict cached for the pair answer for a pasted capture", async () => {
    const { manager, findByFingerprint } = build()
    await manager.getSession()
    const pairFingerprint = findByFingerprint.mock.calls[0][0]

    env.LINKEDIN_COOKIE = RAW
    await manager.getSession()

    expect(findByFingerprint.mock.calls[1][0]).not.toBe(pairFingerprint)
  })
})

describe("env validation fails fast", () => {
  const base = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/profilelens",
    API_KEY: "k",
  }
  const messagesOf = (input: Record<string, string>): string[] => {
    const result = envSchema.safeParse(input)
    return result.success ? [] : result.error.issues.map((issue) => issue.message)
  }

  it("rejects a configuration with neither credential form", () => {
    const messages = messagesOf(base)
    expect(messages.join(" ")).toContain("LINKEDIN_COOKIE")
    expect(messages.join(" ")).toContain("LINKEDIN_LI_AT")
  })

  it("rejects a half-filled pair", () => {
    expect(messagesOf({ ...base, LINKEDIN_LI_AT: "AQ" })).not.toHaveLength(0)
    expect(messagesOf({ ...base, LINKEDIN_JSESSIONID: '"ajax:1"' })).not.toHaveLength(0)
  })

  it("accepts either form on its own", () => {
    expect(messagesOf({ ...base, LINKEDIN_COOKIE: RAW })).toHaveLength(0)
    expect(
      messagesOf({ ...base, LINKEDIN_LI_AT: "AQ", LINKEDIN_JSESSIONID: '"ajax:1"' }),
    ).toHaveLength(0)
  })

  it("rejects a capture with no JSESSIONID, which would 403 on every request", () => {
    const messages = messagesOf({ ...base, LINKEDIN_COOKIE: "li_at=AQEDATEST; lidc=x" })
    expect(messages.join(" ")).toContain("JSESSIONID")
  })

  it("rejects a capture with no li_at, which is not a logged-in session", () => {
    const messages = messagesOf({ ...base, LINKEDIN_COOKIE: 'JSESSIONID="ajax:1"; lidc=x' })
    expect(messages.join(" ")).toContain("li_at")
  })

  it("never puts a credential value in the error", () => {
    const result = envSchema.safeParse({ ...base, LINKEDIN_COOKIE: "lidc=b=OGST00:g=SECRETVALUE" })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).not.toContain("SECRETVALUE")
  })
})
