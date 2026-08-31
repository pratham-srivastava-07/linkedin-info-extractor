import {
  DashCertification,
  DashCollection,
  DashEducation,
  DashLanguage,
  DashPosition,
  DashPositionGroup,
  DashProfile,
  DashProfileResponse,
  DashSkill,
  DashVectorImage,
} from "../interfaces/linkedin"
import { Certification, Education, Experience, Profile } from "../interfaces/profile"
import { SchemaMismatchError } from "../utils/AppError"
import { formatDateRange } from "./dates"

/**
 * Raw Voyager JSON in, the public Profile schema out. Pure — no I/O, no clock, no
 * config. This is the one place an upstream rename has to be absorbed, and the
 * only layer worth heavy unit testing (docs/notes.md § Testing strategy).
 *
 * The input is the **dash** profiles finder response (`{ elements: [profile] }`),
 * which is the surface that still exists. The public schema in docs/api.md is
 * unchanged — absorbing this move is exactly the job this layer is here to do.
 */

/** Non-narrowing on purpose: narrowing to Record<string, unknown> would erase the
 *  Voyager view types on everything downstream. */
const isObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Blank and whitespace-only upstream strings mean "absent", not "empty string". */
const text = (value?: string | null): string | null => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** Joins the non-empty parts of a composite field, or null if there are none. */
const join = (parts: Array<string | null>, separator = ", "): string | null =>
  text(parts.filter(Boolean).join(separator))

/**
 * Every sub-entity arrives as `{ paging, elements }`. A collection upstream
 * omitted entirely is an empty list; one that is no longer shaped like a
 * collection is genuine drift and must be loud.
 */
const elementsOf = <T>(collection: unknown, label: string, raw: unknown): T[] => {
  if (collection === undefined || collection === null) return []
  if (!isObject(collection)) throw new SchemaMismatchError(`${label} was not an object`, raw)
  const { elements } = collection as DashCollection<T>
  if (elements === undefined || elements === null) return []
  if (!Array.isArray(elements)) throw new SchemaMismatchError(`${label}.elements was not an array`, raw)
  return elements
}

const fullName = (first?: string, last?: string): string | null =>
  join([text(first), text(last)], " ")

/**
 * Dash groups positions by employer: one group per company, holding the roles
 * held there, so a promotion within a company is two entries in one group. The
 * public schema is a flat list, so flatten — preserving upstream's order, which
 * is already most-recent-first.
 *
 * A group whose inner collection is missing still carries `companyName` and a
 * `dateRange`, so it degrades to a single company-level entry rather than
 * vanishing.
 */
const toExperiences = (group: DashPositionGroup, raw: unknown): Experience[] => {
  const positions = elementsOf<DashPosition>(
    group.profilePositionInPositionGroup,
    "profilePositionInPositionGroup",
    raw,
  )

  if (positions.length === 0) {
    return [
      {
        title: null,
        company: text(group.companyName),
        duration: formatDateRange(group.dateRange),
        description: null,
      },
    ]
  }

  return positions.map((position) => ({
    title: text(position.title),
    // The company lives on both the position and its group; the group is the
    // fallback because a position occasionally omits it.
    company: text(position.companyName) ?? text(group.companyName),
    duration: formatDateRange(position.dateRange),
    description: text(position.description),
  }))
}

const toEducation = (education: DashEducation): Education => ({
  school: text(education.schoolName) ?? text(education.school?.name),
  // api.md renders this as a single line: "B.Tech, Computer Science".
  degree: join([text(education.degreeName), text(education.fieldOfStudy)]),
  duration: formatDateRange(education.dateRange),
})

const toCertification = (certification: DashCertification): Certification => ({
  name: text(certification.name),
  issuer: text(certification.authority) ?? text(certification.company?.name),
})

/** Dash carries a localized map alongside the plain name; either will do. */
const localizedName = (entity: { name?: string; multiLocaleName?: Record<string, string> }) =>
  text(entity.name) ?? text(Object.values(entity.multiLocaleName ?? {})[0])

/**
 * The one human-readable place string on a dash profile. `location` is only a
 * country code (`{ countryCode: "US" }`), so it is deliberately not used — a
 * bare "US" is worse than null for a field api.md documents as
 * "Bengaluru, Karnataka, India".
 */
const toLocation = (profile: DashProfile): string | null => {
  const geo = profile.geoLocation?.geo
  return (
    text(geo?.defaultLocalizedName) ??
    text(geo?.defaultLocalizedNameWithoutCountryName) ??
    text(geo?.country?.defaultLocalizedName)
  )
}

/**
 * Voyager returns images as a root URL plus size-suffixed path segments. We pick
 * the largest artifact — these URLs are upstream-hosted and expire, which
 * docs/notes.md already records as a known limitation.
 */
const toImageUrl = (image?: DashVectorImage): string | null => {
  const rootUrl = text(image?.rootUrl)
  const artifacts = image?.artifacts
  if (!rootUrl || !Array.isArray(artifacts) || artifacts.length === 0) return null
  const largest = artifacts.reduce((best, candidate) =>
    (candidate.width ?? 0) > (best.width ?? 0) ? candidate : best,
  )
  const segment = text(largest.fileIdentifyingUrlPathSegment)
  return segment ? `${rootUrl}${segment}` : null
}

export interface NormalizationContext {
  profileUrl: string
  fetchedAt: Date
}

/**
 * Unwraps the finder envelope. An empty `elements` array is a profile that does
 * not exist, and the client classifies that as a 404 before we ever get here —
 * so reaching this function with one really is drift.
 */
const profileFrom = (raw: DashProfileResponse): DashProfile => {
  if (!isObject(raw)) throw new SchemaMismatchError("Response was not a JSON object", raw)

  const { elements } = raw
  if (!Array.isArray(elements)) {
    throw new SchemaMismatchError("Response is missing the `elements` array", raw)
  }
  const profile = elements[0]
  if (!profile || !isObject(profile)) {
    throw new SchemaMismatchError("Response carried no profile in `elements`", raw)
  }
  return profile
}

export const normalizeProfile = (
  raw: DashProfileResponse,
  { profileUrl, fetchedAt }: NormalizationContext,
): Profile => {
  const profile = profileFrom(raw)

  const name = fullName(profile.firstName, profile.lastName)
  const headline = text(profile.headline)
  // A payload with neither of these is not a profile we understand — better a
  // loud 502 than a response full of nulls that looks like an empty profile.
  if (!name && !headline) {
    throw new SchemaMismatchError("Response carried neither a name nor a headline", raw)
  }

  return {
    profileUrl,
    name,
    headline,
    location: toLocation(profile),
    about: text(profile.summary),
    experience: elementsOf<DashPositionGroup>(
      profile.profilePositionGroups,
      "profilePositionGroups",
      raw,
    ).flatMap((group) => toExperiences(group, raw)),
    education: elementsOf<DashEducation>(profile.profileEducations, "profileEducations", raw).map(
      toEducation,
    ),
    skills: elementsOf<DashSkill>(profile.profileSkills, "profileSkills", raw)
      .map(localizedName)
      .filter((skill): skill is string => skill !== null),
    certifications: elementsOf<DashCertification>(
      profile.profileCertifications,
      "profileCertifications",
      raw,
    )
      .map(toCertification)
      .filter((certification) => certification.name !== null),
    languages: elementsOf<DashLanguage>(profile.profileLanguages, "profileLanguages", raw)
      .map(localizedName)
      .filter((language): language is string => language !== null),
    profileImageUrl: toImageUrl(profile.profilePicture?.displayImageReference?.vectorImage),
    fetchedAt: fetchedAt.toISOString(),
  }
}
