import { describe, expect, it } from "vitest"
import { diagnoseAuthFailure } from "../src/linkedin/revocation"
import { parseCurl, tokenize } from "../scripts/curl"

/**
 * Two diagnostics that only exist because of one experiment: LinkedIn accepted a
 * two-cookie request once and then revoked the session, and the proof was in the
 * `Set-Cookie` of the following 302. `check:session` has to be able to tell that
 * apart from an ordinary expiry, and `import:cookie` has to make the full
 * capture easy enough that nobody assembles one by hand.
 */

describe("diagnoseAuthFailure", () => {
  const REVOCATION = [
    'li_at="delete me"; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=0; Path=/; Domain=.linkedin.com',
    'li_a="delete me"; Max-Age=0; Path=/; Domain=.www.linkedin.com',
    'liap="delete me"; Max-Age=0; Path=/; Domain=.linkedin.com',
    'lidc="b=OGST00:g=1234"; Expires=Wed, 02-Sep-2026 00:00:00 GMT; Path=/',
  ]

  it("reads the delete-me tombstone as an active revocation", () => {
    const diagnosis = diagnoseAuthFailure(REVOCATION, "https://www.linkedin.com/uas/login")

    expect(diagnosis.kind).toBe("revoked")
    expect(diagnosis.revokedCookies).toEqual(["li_at", "li_a", "liap"])
    // A cookie being refreshed is not a cookie being killed.
    expect(diagnosis.revokedCookies).not.toContain("lidc")
  })

  it.each([
    ['li_at="delete me"; Max-Age=0', "the tombstone value and Max-Age together"],
    ["li_at=whatever; Max-Age=0; Path=/", "Max-Age=0 alone"],
    ["li_at=whatever; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Path=/", "a 1970 expiry alone"],
  ])("treats %s as revocation (%s)", (setCookie) => {
    expect(diagnoseAuthFailure([setCookie], null).kind).toBe("revoked")
  })

  it("does not call an ordinary login redirect a revocation", () => {
    expect(diagnoseAuthFailure([], "https://www.linkedin.com/uas/login?fromSignIn=true")).toEqual({
      kind: "login_wall",
      revokedCookies: [],
    })
  })

  it("flags a checkpoint as needing the browser", () => {
    expect(diagnoseAuthFailure([], "https://www.linkedin.com/checkpoint/challenge/xyz").kind).toBe(
      "checkpoint",
    )
  })

  it("falls back to generic guidance for anything else", () => {
    expect(diagnoseAuthFailure([], "/feed/").kind).toBe("unknown")
    expect(diagnoseAuthFailure([], null).kind).toBe("unknown")
  })

  it("ignores a refreshed session cookie", () => {
    const refreshed = ['li_at=AQEDA-new-value; Expires=Wed, 02-Sep-2027 00:00:00 GMT; Path=/']
    expect(diagnoseAuthFailure(refreshed, null).kind).toBe("unknown")
    expect(diagnoseAuthFailure(refreshed, null).revokedCookies).toEqual([])
  })
})

describe("parseCurl", () => {
  const COOKIE = 'bcookie="v=2&abc"; JSESSIONID="ajax:123"; li_at=AQEDATEST; lidc="b=OGST00"'

  it("reads a Copy-as-cURL (bash) blob with line continuations", () => {
    const blob = [
      "curl 'https://www.linkedin.com/voyager/api/me' \\",
      "  -H 'accept: application/json' \\",
      `  -H 'cookie: ${COOKIE}' \\`,
      "  -H 'csrf-token: ajax:123' \\",
      `  -H 'x-li-track: {"clientVersion":"1.13.1","osName":"web"}' \\`,
      "  -H 'x-li-page-instance: urn:li:page:d_flagship3_profile_view_base;abc==' \\",
      "  -H 'user-agent: Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0' \\",
      "  --compressed",
    ].join("\n")

    expect(parseCurl(blob)).toEqual({
      cookie: COOKIE,
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0",
      xLiTrack: '{"clientVersion":"1.13.1","osName":"web"}',
      xLiPageInstance: "urn:li:page:d_flagship3_profile_view_base;abc==",
    })
  })

  it("handles the double-quoted spelling, where inner quotes are escaped", () => {
    // A double-quoted argument has to escape the quotes inside the cookie value.
    // Unescaped ones would close the argument, which is what the next test covers.
    const escaped = COOKIE.replace(/"/g, '\\"')
    const blob = [
      'curl "https://www.linkedin.com/voyager/api/me" \\',
      `  -H "cookie: ${escaped}" \\`,
      '  -H "x-li-track: {\\"clientVersion\\":\\"1.13.1\\"}"',
    ].join("\n")

    const parsed = parseCurl(blob)
    expect(parsed.cookie).toBe(COOKIE)
    expect(parsed.xLiTrack).toBe('{"clientVersion":"1.13.1"}')
  })

  it("drops unescaped inner quotes, exactly as a shell would", () => {
    // Documents the boundary instead of pretending the value is recoverable:
    // by the time an unescaped blob reaches us the quoting is already ambiguous.
    const blob = `curl https://x -H "cookie: ${COOKIE}"`
    expect(parseCurl(blob).cookie).toBe(COOKIE.replace(/"/g, ""))
  })

  it("handles the -b / --cookie form", () => {
    const escaped = COOKIE.replace(/"/g, '\\"')
    expect(parseCurl(`curl https://x -b '${COOKIE}'`).cookie).toBe(COOKIE)
    expect(parseCurl(`curl https://x --cookie "${escaped}"`).cookie).toBe(COOKIE)
  })

  it("prefers the cookie header the browser actually sent over -b", () => {
    const blob = `curl https://x -b 'li_at=OLD' -H 'cookie: ${COOKIE}'`
    expect(parseCurl(blob).cookie).toBe(COOKIE)
  })

  it("matches header names case-insensitively", () => {
    expect(parseCurl(`curl https://x -H 'Cookie: ${COOKIE}' -H 'User-Agent: UA/1'`)).toMatchObject({
      cookie: COOKIE,
      userAgent: "UA/1",
    })
  })

  it("reports nothing found rather than a half-parsed capture", () => {
    expect(parseCurl("curl https://www.linkedin.com/voyager/api/me")).toEqual({
      cookie: null,
      userAgent: null,
      xLiTrack: null,
      xLiPageInstance: null,
    })
    expect(parseCurl("").cookie).toBeNull()
  })

  it("keeps a quoted value with spaces and semicolons in one token", () => {
    expect(tokenize("curl -H 'cookie: a=1; b=2'")).toEqual(["curl", "-H", "cookie: a=1; b=2"])
  })
})
