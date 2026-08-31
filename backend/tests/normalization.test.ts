import { describe, expect, it } from "vitest"
import full from "./fixtures/full-profile.json"
import sparse from "./fixtures/sparse-profile.json"
import edge from "./fixtures/edge-profile.json"
import { normalizeProfile } from "../src/normalization/normalizeProfile"
import { formatDateRange } from "../src/normalization/dates"
import { SchemaMismatchError } from "../src/utils/AppError"
import { DashProfileResponse } from "../src/interfaces/linkedin"
import { Profile } from "../src/interfaces/profile"

/**
 * All three fixtures are **real captured payloads** from
 * `GET /identity/dash/profiles?q=memberIdentity&…&decorationId=…FullProfileWithEntities-93`,
 * saved with `npm run capture:fixture`. They are public figures deliberately —
 * tests/fixtures/ is checked in and each file is a complete profile.
 *
 *   full-profile   arianna huffington — summary, skills, a certification,
 *                  education with degree + field of study, a photo
 *   sparse-profile bill gates — genuinely sparse: `paging.total === 0` for
 *                  skills, certifications, languages, projects and honours, no
 *                  degrees, no position descriptions, no position locations
 *   edge-profile   satya nadella — five position groups, and an education entry
 *                  that carries no `schoolName` at all (only the nested
 *                  `school` object), plus two with no dateRange
 *
 * A few upstream shapes exist that none of these three profiles happens to
 * carry — a position `description`, a position group with no nested positions,
 * whitespace-only strings, a missing name. Those are covered below by objects
 * **trimmed by hand from a real captured payload**, not invented: the
 * `description` and `locationName` spellings were both observed on a live
 * capture (a profile with a written-up role) and the rest are the same
 * envelope with fields removed.
 */

const ctx = {
  profileUrl: "https://www.linkedin.com/in/jane-doe/",
  fetchedAt: new Date("2026-08-30T10:00:00.000Z"),
}

const PROFILE_KEYS: Array<keyof Profile> = [
  "profileUrl", "name", "headline", "location", "about", "experience", "education",
  "skills", "certifications", "languages", "profileImageUrl", "fetchedAt",
]

/** The finder envelope every real response arrives in. */
const envelope = (profile: unknown): DashProfileResponse =>
  ({ elements: [profile], paging: { total: 1, count: 10, start: 0 } }) as DashProfileResponse

describe("normalizeProfile — full profile (real capture)", () => {
  const result = normalizeProfile(full, ctx)

  it("maps every documented field", () => {
    for (const key of PROFILE_KEYS) expect(result).toHaveProperty(key)
    expect(result).toMatchObject({
      profileUrl: ctx.profileUrl,
      name: "Arianna Huffington",
      headline: "Founder and CEO at Thrive Global | Passionate about Health and AI",
      location: "New York, New York, United States",
      fetchedAt: "2026-08-30T10:00:00.000Z",
    })
    expect(result.about).toContain("I’m the founder and CEO of Thrive Global")
  })

  it("flattens position groups into a single experience list", () => {
    expect(result.experience).toEqual([
      {
        title: "Founder and CEO",
        company: "Thrive Global",
        duration: "Sep 2016 - Present",
        description: null,
      },
      {
        title: "President and Editor-in-Chief",
        company: "The Huffington Post Media Group",
        duration: "May 2005 - Aug 2016",
        description: null,
      },
    ])
  })

  it("joins degree and field of study onto one line", () => {
    expect(result.education).toEqual([
      {
        school: "Cambridge University",
        degree: "Master of Arts (M.A.), Economics",
        duration: "1968 - 1972",
      },
    ])
  })

  it("reads skills off the injected collection", () => {
    expect(result.skills).toEqual([
      "Career Development", "Writing", "Communication", "Career",
      "Technology", "Public Speaking", "Health", "Leadership",
    ])
  })

  it("maps a certification issuer from its authority", () => {
    expect(result.certifications).toEqual([{ name: "Thriving Mind", issuer: "Thrive Global" }])
  })

  it("resolves the display image reference to the largest artifact", () => {
    // The vector image sits under profilePicture.displayImageReference.vectorImage
    // on dash; 800x800 is the biggest artifact upstream offers.
    expect(result.profileImageUrl).toContain("profile-displayphoto-shrink_800_800")
    expect(result.profileImageUrl).toMatch(/^https:\/\/media\.licdn\.com\/dms\/image\//)
  })
})

describe("normalizeProfile — sparse profile (real capture)", () => {
  const result = normalizeProfile(sparse, ctx)

  it("emits every key, using null and [] rather than omitting", () => {
    for (const key of PROFILE_KEYS) expect(result).toHaveProperty(key)
    expect(result.name).toBe("Bill Gates")
    expect(result.skills).toEqual([])
    expect(result.certifications).toEqual([])
    expect(result.languages).toEqual([])
  })

  it("keeps year-only ranges and leaves an undated entry null", () => {
    expect(result.education).toEqual([
      { school: "Harvard University", degree: null, duration: "1973 - 1975" },
      { school: "Lakeside School", degree: null, duration: null },
    ])
  })

  it("nulls a description upstream never sent", () => {
    expect(result.experience).toHaveLength(3)
    expect(result.experience.every((role) => role.description === null)).toBe(true)
    expect(result.experience[2]).toEqual({
      title: "Co-founder",
      company: "Microsoft",
      duration: "1975 - Present",
      description: null,
    })
  })
})

describe("normalizeProfile — edge cases (real capture)", () => {
  const result = normalizeProfile(edge, ctx)

  it("keeps every position group, most recent first", () => {
    expect(result.experience.map((role) => role.company)).toEqual([
      "Microsoft",
      "University of Chicago",
      "Starbucks",
      "The Business Council U.S.",
      "Fred Hutch",
    ])
    expect(result.experience[0].duration).toBe("Feb 2014 - Present")
    expect(result.experience[2].duration).toBe("2017 - 2024")
  })

  it("falls back to the nested school object when schoolName is missing", () => {
    // Upstream sent this entry with a dateRange and a `school` object but no
    // top-level schoolName — dropping it would silently lose an education.
    expect(result.education[0]).toEqual({
      school: "The University of Chicago Booth School of Business",
      degree: null,
      duration: "1994 - 1996",
    })
  })

  it("still renders degree and field where the dates are absent", () => {
    expect(result.education[1]).toEqual({
      school: "Manipal Institute of Technology, Manipal",
      degree: "Bachelor’s Degree, Electrical Engineering",
      duration: null,
    })
  })
})

/**
 * Shapes trimmed from real captures for the paths no single sampled profile
 * exercises. Each field name below was observed on a live 200.
 */
describe("normalizeProfile — trimmed shapes", () => {
  it("keeps a position description and both roles held at one company", () => {
    const result = normalizeProfile(
      envelope({
        firstName: "Ada",
        lastName: "Lovelace",
        profilePositionGroups: {
          paging: { total: 1, count: 10, start: 0 },
          elements: [
            {
              companyName: "Analytical Engines",
              dateRange: { start: { month: 1, year: 2019 } },
              profilePositionInPositionGroup: {
                paging: { total: 2, count: 20, start: 0 },
                elements: [
                  {
                    title: "Principal Engineer",
                    companyName: "Analytical Engines",
                    dateRange: { start: { month: 6, year: 2022 } },
                    locationName: "Delhi, India",
                    description: "Built cross-platform services.\nRan the ingestion pipeline.",
                  },
                  {
                    title: "Engineer",
                    dateRange: { start: { month: 1, year: 2019 }, end: { month: 5, year: 2022 } },
                  },
                ],
              },
            },
          ],
        },
      }),
      ctx,
    )

    expect(result.experience).toEqual([
      {
        title: "Principal Engineer",
        company: "Analytical Engines",
        duration: "Jun 2022 - Present",
        description: "Built cross-platform services.\nRan the ingestion pipeline.",
      },
      {
        // The position omitted companyName; the group supplies it.
        title: "Engineer",
        company: "Analytical Engines",
        duration: "Jan 2019 - May 2022",
        description: null,
      },
    ])
  })

  it("degrades a position group with no nested positions to a company-level entry", () => {
    const result = normalizeProfile(
      envelope({
        firstName: "Ada",
        lastName: "Lovelace",
        profilePositionGroups: {
          elements: [
            {
              companyName: "Analytical Engines",
              dateRange: { start: { year: 2019 }, end: { year: 2021 } },
            },
          ],
        },
      }),
      ctx,
    )

    expect(result.experience).toEqual([
      { title: null, company: "Analytical Engines", duration: "2019 - 2021", description: null },
    ])
  })

  it("treats whitespace-only strings as absent", () => {
    const result = normalizeProfile(
      envelope({ firstName: "  Ada  ", lastName: " ", headline: "   ", summary: "\n\t" }),
      ctx,
    )

    expect(result.name).toBe("Ada")
    expect(result.headline).toBeNull()
    expect(result.about).toBeNull()
  })

  it("drops nameless skills, languages and certifications", () => {
    const result = normalizeProfile(
      envelope({
        firstName: "Ada",
        lastName: "Lovelace",
        profileSkills: { elements: [{ name: "Go" }, { name: "  " }, {}] },
        // profileLanguages was empty on every profile sampled; this is the
        // inferred shape, mirroring profileSkills. See docs/notes.md.
        profileLanguages: { elements: [{ name: "English" }, { proficiency: "NATIVE" }] },
        profileCertifications: {
          elements: [
            { name: "Internal Cert", company: { name: "Another Co" } },
            { authority: "No Name Co" },
          ],
        },
      }),
      ctx,
    )

    expect(result.skills).toEqual(["Go"])
    expect(result.languages).toEqual(["English"])
    expect(result.certifications).toEqual([{ name: "Internal Cert", issuer: "Another Co" }])
  })

  it("falls back to a localized name when the plain one is missing", () => {
    const result = normalizeProfile(
      envelope({
        firstName: "Ada",
        lastName: "Lovelace",
        profileSkills: { elements: [{ multiLocaleName: { en_US: "PostgreSQL" } }] },
      }),
      ctx,
    )

    expect(result.skills).toEqual(["PostgreSQL"])
  })

  it("falls back through the geo names, and never reports a bare country code", () => {
    const withoutFullName = normalizeProfile(
      envelope({
        firstName: "Ada",
        lastName: "Lovelace",
        // `location` is only ever { countryCode: "US" } — useless as a location.
        location: { countryCode: "IN" },
        geoLocation: { geo: { country: { defaultLocalizedName: "India" } } },
      }),
      ctx,
    )
    expect(withoutFullName.location).toBe("India")

    const withNoGeo = normalizeProfile(
      envelope({ firstName: "Ada", lastName: "Lovelace", location: { countryCode: "IN" } }),
      ctx,
    )
    expect(withNoGeo.location).toBeNull()
  })

  it("returns null for an image with no artifacts", () => {
    const result = normalizeProfile(
      envelope({
        firstName: "Ada",
        lastName: "Lovelace",
        profilePicture: {
          displayImageReference: { vectorImage: { rootUrl: "https://media.licdn.com/x/", artifacts: [] } },
        },
      }),
      ctx,
    )

    expect(result.profileImageUrl).toBeNull()
  })
})

describe("normalizeProfile — schema drift", () => {
  it("throws SchemaMismatchError when the elements envelope is gone", () => {
    expect(() => normalizeProfile({ profile: { firstName: "A" } } as never, ctx)).toThrow(
      SchemaMismatchError,
    )
  })

  it("throws when a collection is no longer shaped like one", () => {
    expect(() =>
      normalizeProfile(
        envelope({ firstName: "A", lastName: "B", profileSkills: { elements: {} } }) as never,
        ctx,
      ),
    ).toThrow(SchemaMismatchError)
  })

  it("throws rather than returning an all-null profile", () => {
    expect(() => normalizeProfile(envelope({ publicIdentifier: "nobody" }), ctx)).toThrow(
      SchemaMismatchError,
    )
  })

  it("throws when the finder returned an envelope with nothing in it", () => {
    // The client classifies this as a 404 first, so reaching the normalizer
    // with it really is drift.
    expect(() => normalizeProfile({ elements: [] }, ctx)).toThrow(SchemaMismatchError)
  })

  it("carries the raw payload, status and code for debugging", () => {
    const raw = { unexpected: true }
    try {
      normalizeProfile(raw as never, ctx)
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaMismatchError)
      expect((err as SchemaMismatchError).rawPayload).toBe(raw)
      expect((err as SchemaMismatchError).statusCode).toBe(502)
      expect((err as SchemaMismatchError).code).toBe("upstream_schema_mismatch")
    }
  })
})

describe("formatDateRange", () => {
  it.each([
    [{ start: { month: 1, year: 2022 } }, "Jan 2022 - Present"],
    [{ start: { year: 2016 }, end: { year: 2020 } }, "2016 - 2020"],
    [{ end: { month: 6, year: 2019 } }, "Jun 2019"],
    [{}, null],
    [{ start: { month: 13, year: 2020 } }, "2020 - Present"],
  ])("formats %o", (range, expected) => {
    expect(formatDateRange(range)).toBe(expected)
  })
})
