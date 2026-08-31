/**
 * Loose views over LinkedIn's Voyager payloads.
 *
 * These describe the **dash** profile surface
 * (`GET /identity/dash/profiles?q=memberIdentity&…`), which is what actually
 * exists today: the legacy `/identity/profiles/{id}/profileView` family was
 * retired and answers HTTP 410 (docs/notes.md).
 *
 * Intentionally all-optional: upstream is versioned by nobody and changes
 * without notice, so the normalizer must be free to inspect what actually
 * arrived and raise SchemaMismatchError itself rather than have `strict` types
 * lie about it. Every interface here was written against a captured 200 — see
 * `tests/fixtures/`.
 */

/** Dash renders a partial date as year, or year + 1-based month. */
export interface DashDate {
  day?: number
  month?: number
  year?: number
}

/** Replaces the legacy `timePeriod: { startDate, endDate }`. */
export interface DashDateRange {
  start?: DashDate
  end?: DashDate
}

/**
 * Every sub-entity arrives as a paged collection injected into the profile.
 * `paging.total` can exceed `elements.length` — the injection is capped
 * upstream (20 skills, 10 position groups), which is a documented limitation.
 */
export interface DashCollection<T> {
  paging?: { total?: number; count?: number; start?: number }
  elements?: T[]
}

export interface DashVectorImage {
  rootUrl?: string
  artifacts?: Array<{
    width?: number
    height?: number
    fileIdentifyingUrlPathSegment?: string
  }>
}

/** A profile photo reference. The vector image is one level deeper than legacy. */
export interface DashImageReference {
  vectorImage?: DashVectorImage
}

export interface DashProfilePicture {
  displayImageUrn?: string
  displayImageReference?: DashImageReference
}

export interface DashPosition {
  title?: string
  companyName?: string
  description?: string
  locationName?: string
  dateRange?: DashDateRange
  companyUrn?: string
  employmentType?: { name?: string }
}

/**
 * Positions are grouped by company: one group per employer, holding the roles
 * held there. A single-role group still nests its one position inside
 * `profilePositionInPositionGroup`.
 */
export interface DashPositionGroup {
  companyName?: string
  dateRange?: DashDateRange
  profilePositionInPositionGroup?: DashCollection<DashPosition>
}

export interface DashEducation {
  schoolName?: string
  degreeName?: string
  fieldOfStudy?: string
  dateRange?: DashDateRange
  school?: { name?: string }
}

export interface DashSkill {
  name?: string
  multiLocaleName?: Record<string, string>
}

export interface DashCertification {
  name?: string
  authority?: string
  url?: string
  dateRange?: DashDateRange
  company?: { name?: string }
}

/**
 * Not observed populated on any profile we sampled — every capture had
 * `profileLanguages.paging.total === 0`. The field names mirror
 * `DashSkill`/`DashCertification` and the legacy `languageView`; treat this
 * one interface as inferred rather than confirmed (docs/notes.md).
 */
export interface DashLanguage {
  name?: string
  proficiency?: string
  multiLocaleName?: Record<string, string>
}

export interface DashGeo {
  /** "Seattle, Washington, United States" — the one we want. */
  defaultLocalizedName?: string
  /** "Seattle, Washington" */
  defaultLocalizedNameWithoutCountryName?: string
  country?: { defaultLocalizedName?: string }
}

/** One element of the dash profiles finder. */
export interface DashProfile {
  firstName?: string
  lastName?: string
  headline?: string
  summary?: string
  publicIdentifier?: string
  entityUrn?: string
  objectUrn?: string
  industry?: { name?: string }
  /** Only a country code (`{ countryCode: "US" }`) — not a human-readable place. */
  location?: { countryCode?: string }
  geoLocation?: { geo?: DashGeo }
  profilePicture?: DashProfilePicture
  profilePositionGroups?: DashCollection<DashPositionGroup>
  profileEducations?: DashCollection<DashEducation>
  profileSkills?: DashCollection<DashSkill>
  profileCertifications?: DashCollection<DashCertification>
  profileLanguages?: DashCollection<DashLanguage>
}

/**
 * Response of
 * `GET /identity/dash/profiles?q=memberIdentity&memberIdentity={publicId}&decorationId={deco}`.
 *
 * A restli finder, so the profile is wrapped in `elements` even though exactly
 * one is ever returned.
 */
export interface DashProfileResponse {
  elements?: DashProfile[]
  paging?: { total?: number; count?: number; start?: number }
}

/** Minimal view of GET /me, used only to prove a session is still alive. */
export interface VoyagerMe {
  plainId?: number
  miniProfile?: { publicIdentifier?: string; firstName?: string; lastName?: string }
  "*miniProfile"?: string
}
