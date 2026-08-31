import { afterEach, describe, expect, it, vi } from "vitest"
import { VoyagerClient } from "../src/linkedin/voyagerClient"
import {
  UpstreamAuthError,
  UpstreamGoneError,
  UpstreamNotFoundError,
  UpstreamRateLimitError,
  UpstreamUnavailableError,
} from "../src/linkedin/errors"

/**
 * The extraction layer is plain HTTPS — no browser — so it can be tested by
 * stubbing fetch. Covers the things docs/notes.md calls out as the usual causes
 * of an unexplained failure: the CSRF header derivation, and the status codes
 * that do not mean what they look like (302 = expired, 999 = throttled,
 * 410 = the endpoint is gone, 403 = *usually* the profile, not the session).
 */

const cookies = { liAt: "AQEDATEST", jsessionId: '"ajax:9876543210"' }
const client = new VoyagerClient()

const ELEMENTS = { elements: [{ firstName: "Jane" }], paging: { total: 1 } }

const stubFetch = (response: Response) => {
  const spy = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal("fetch", spy)
  return spy
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * A body-less response, built by hand rather than with `new Response(...)`:
 * the constructor rejects any status outside 200-599, and LinkedIn's 999 — the
 * one status this client most needs to handle — is outside it. undici has no
 * such restriction on a response it receives from the wire.
 */
const statusResponse = (status: number, headers: Record<string, string> = {}): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => ({}),
    text: async () => "",
  }) as unknown as Response

/** Resolves with whatever the call rejected with, so fields can be asserted. */
const rejection = (promise: Promise<unknown>): Promise<any> =>
  promise.then(
    () => {
      throw new Error("expected the call to reject")
    },
    (err) => err,
  )

afterEach(() => vi.unstubAllGlobals())

describe("VoyagerClient — request shape", () => {
  it("fetches the dash profiles finder once, with the session headers Voyager requires", async () => {
    const fetchSpy = stubFetch(jsonResponse(ELEMENTS))

    await client.profile("jane-doe", cookies)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const parsed = new URL(String(url))
    expect(parsed.origin + parsed.pathname).toBe(
      "https://www.linkedin.com/voyager/api/identity/dash/profiles",
    )
    expect(parsed.searchParams.get("q")).toBe("memberIdentity")
    expect(parsed.searchParams.get("memberIdentity")).toBe("jane-doe")
    // The decoration is what turns the top-card projection into a full profile.
    expect(parsed.searchParams.get("decorationId")).toContain("FullProfileWithEntities")

    const headers = init.headers as Record<string, string>
    // The cookie keeps the quotes; the csrf-token header drops them. A mismatch
    // here is the documented cause of a blanket 403.
    expect(headers.cookie).toBe('li_at=AQEDATEST; JSESSIONID="ajax:9876543210"')
    expect(headers["csrf-token"]).toBe("ajax:9876543210")
    expect(headers["x-restli-protocol-version"]).toBe("2.0.0")
    expect(headers["user-agent"]).toMatch(/Mozilla\/5\.0/)
    // A followed redirect would hand us the login page as a 200.
    expect(init.redirect).toBe("manual")
  })

  it("percent-encodes the public id into the query string", async () => {
    const fetchSpy = stubFetch(jsonResponse(ELEMENTS))

    await client.profile("jørn-nilsen", cookies)

    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain("memberIdentity=j%C3%B8rn-nilsen")
    expect(new URL(url).searchParams.get("memberIdentity")).toBe("jørn-nilsen")
  })

  it("returns the raw payload unshaped", async () => {
    stubFetch(jsonResponse(ELEMENTS))

    await expect(client.profile("jane-doe", cookies)).resolves.toEqual(ELEMENTS)
  })

  it("still hits /me for the liveness check", async () => {
    const fetchSpy = stubFetch(jsonResponse({ plainId: 1 }))

    await client.me(cookies)

    expect(String(fetchSpy.mock.calls[0][0])).toBe("https://www.linkedin.com/voyager/api/me")
  })
})

describe("VoyagerClient — status mapping", () => {
  it.each([301, 302, 303, 307, 308])(
    "treats a %i redirect as an expired session, not a success",
    async (status) => {
      stubFetch(statusResponse(status, { location: "/uas/login" }))

      await expect(client.profile("jane-doe", cookies)).rejects.toBeInstanceOf(UpstreamAuthError)
    },
  )

  it("maps 401 to an auth error", async () => {
    stubFetch(statusResponse(401))

    await expect(client.profile("jane-doe", cookies)).rejects.toBeInstanceOf(UpstreamAuthError)
  })

  /**
   * The dash profiles finder never 404s. A profile that is private, out of
   * network, or simply does not exist all come back as this 403 — observed on a
   * live session that was demonstrably healthy either side of the call. Reading
   * it as an auth failure would invalidate a good session and 503 the service
   * because one profile happened to be unreadable.
   */
  it("maps a 403 that names VoyagerUserVisibleException to a missing profile", async () => {
    stubFetch(
      jsonResponse(
        {
          exceptionClass: "com.linkedin.voyager.common.VoyagerUserVisibleException",
          message: "This profile can't be accessed",
          status: 403,
        },
        403,
      ),
    )

    const err = await rejection(client.profile("ghost", cookies))
    expect(err).toBeInstanceOf(UpstreamNotFoundError)
    expect(err.publicId).toBe("ghost")
  })

  it("still maps a bare 403 to an auth error — that one is the CSRF/session case", async () => {
    stubFetch(new Response("", { status: 403 }))

    await expect(client.profile("jane-doe", cookies)).rejects.toBeInstanceOf(UpstreamAuthError)
  })

  it("maps 404 to a not-found carrying the public id", async () => {
    stubFetch(statusResponse(404))

    const err = await rejection(client.profile("ghost", cookies))
    expect(err).toBeInstanceOf(UpstreamNotFoundError)
    expect(err.publicId).toBe("ghost")
  })

  /**
   * The regression this whole rewrite came out of: the retired
   * `/identity/profiles/{id}/profileView` family answers 410, and while that
   * fell through to "unavailable" it surfaced as `503 session_unavailable` —
   * a retired endpoint wearing the costume of a dead cookie.
   */
  it("maps 410 to a distinct gone error, never an auth failure", async () => {
    stubFetch(statusResponse(410))

    const err = await rejection(client.profile("jane-doe", cookies))
    expect(err).toBeInstanceOf(UpstreamGoneError)
    expect(err).not.toBeInstanceOf(UpstreamAuthError)
    expect(err.message).toMatch(/retired/i)
    expect(err.message).toMatch(/not a session problem/i)
  })

  it.each([429, 999])("maps %i to a rate limit, defaulting the retry window", async (status) => {
    stubFetch(statusResponse(status))

    const err = await rejection(client.profile("jane-doe", cookies))
    expect(err).toBeInstanceOf(UpstreamRateLimitError)
    expect(err.retryAfterSeconds).toBe(30)
  })

  it("honours a Retry-After header", async () => {
    stubFetch(statusResponse(429, { "retry-after": "90" }))

    const err = await rejection(client.profile("jane-doe", cookies))
    expect(err.retryAfterSeconds).toBe(90)
  })

  it("maps an unexpected server error to unavailable", async () => {
    stubFetch(statusResponse(500))

    await expect(client.profile("jane-doe", cookies)).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    )
  })

  it("maps a non-JSON 200 to unavailable rather than letting it reach the normalizer", async () => {
    stubFetch(new Response("<!doctype html><html>login</html>", { status: 200 }))

    await expect(client.profile("jane-doe", cookies)).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    )
  })

  it("maps a transport failure to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNRESET")))

    await expect(client.profile("jane-doe", cookies)).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    )
  })

  it("treats an empty finder result as a missing profile, not a broken schema", async () => {
    stubFetch(jsonResponse({ elements: [], paging: { total: 0 } }))

    const err = await rejection(client.profile("ghost", cookies))
    expect(err).toBeInstanceOf(UpstreamNotFoundError)
  })
})
