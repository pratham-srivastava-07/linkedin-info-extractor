import { describe, expect, it } from "vitest"
import { parseProfileUrl } from "../src/validators/profile"
import { AppError } from "../src/utils/AppError"
import { csrfTokenFrom, cookieHeaderFrom } from "../src/linkedin/cookies"

describe("parseProfileUrl", () => {
  it.each([
    "https://www.linkedin.com/in/jane-doe",
    "https://www.linkedin.com/in/jane-doe/",
    "https://linkedin.com/in/jane-doe/",
    "https://in.linkedin.com/in/jane-doe/",
    "https://www.linkedin.com/in/jane-doe/?originalSubdomain=in",
    "  https://www.linkedin.com/in/jane-doe/details/experience/  ",
  ])("canonicalizes %s", (url) => {
    expect(parseProfileUrl(url)).toEqual({
      publicId: "jane-doe",
      canonicalUrl: "https://www.linkedin.com/in/jane-doe/",
    })
  })

  it("decodes percent-encoded public ids", () => {
    expect(parseProfileUrl("https://www.linkedin.com/in/j%C3%B8rn-nilsen").publicId).toBe(
      "jørn-nilsen",
    )
  })

  it.each([
    "",
    "not a url",
    "ftp://www.linkedin.com/in/jane-doe",
    "https://example.com/in/jane-doe",
    "https://www.linkedin.com/company/example-co/",
    "https://www.linkedin.com/school/example-university/",
    "https://www.linkedin.com/in/",
    "https://www.linkedin-evil.com/in/jane-doe",
  ])("rejects %s with invalid_url", (url) => {
    try {
      parseProfileUrl(url)
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe("invalid_url")
      expect((err as AppError).statusCode).toBe(400)
    }
  })
})

describe("cookie handling", () => {
  it("strips the quotes from JSESSIONID to build the csrf token", () => {
    expect(csrfTokenFrom('"ajax:1234567890"')).toBe("ajax:1234567890")
    expect(csrfTokenFrom("ajax:1234567890")).toBe("ajax:1234567890")
  })

  it("keeps JSESSIONID quoted in the cookie header regardless of input form", () => {
    const expected = 'li_at=AQEDA; JSESSIONID="ajax:123"'
    expect(cookieHeaderFrom({ liAt: "AQEDA", jsessionId: '"ajax:123"' })).toBe(expected)
    expect(cookieHeaderFrom({ liAt: "AQEDA", jsessionId: "ajax:123" })).toBe(expected)
    // A hand-pasted env var can lose one of its quotes or pick up whitespace.
    expect(cookieHeaderFrom({ liAt: "AQEDA", jsessionId: '"ajax:123' })).toBe(expected)
    expect(cookieHeaderFrom({ liAt: " AQEDA ", jsessionId: ' "ajax:123" ' })).toBe(expected)
  })
})
