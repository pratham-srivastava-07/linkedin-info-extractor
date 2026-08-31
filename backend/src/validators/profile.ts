import { z } from "zod"
import { invalidUrl } from "../utils/AppError"

// Messages are spelled out so a caller sees the contract, not Zod's internal
// phrasing ("expected string, received undefined") in the published error body.
export const extractProfileSchema = z
  .object({ url: z.string("url is required").trim().min(1, "url is required") })
  .strict()

export type ExtractProfileInput = z.infer<typeof extractProfileSchema>

/** Hosts LinkedIn serves profiles from — country subdomains included (in., uk., …). */
const LINKEDIN_HOST = /^([a-z]{2,3}\.)?(www\.)?linkedin\.com$/i

export interface ParsedProfileUrl {
  publicId: string
  /** One canonical spelling per profile, so the cache can't hold duplicates. */
  canonicalUrl: string
}

/**
 * Validates and canonicalizes a profile URL. Throws `invalid_url` (400) so a bad
 * input never reaches the network — required by the failure-mode table in
 * docs/architecture.md.
 */
export const parseProfileUrl = (raw: string): ParsedProfileUrl => {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw invalidUrl()
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw invalidUrl()
  if (!LINKEDIN_HOST.test(parsed.hostname)) throw invalidUrl()

  const segments = parsed.pathname.split("/").filter(Boolean)
  // A member profile is /in/<publicId>; /company/… and /school/… are other entities.
  if (segments.length < 2 || segments[0].toLowerCase() !== "in") throw invalidUrl()

  let publicId: string
  try {
    publicId = decodeURIComponent(segments[1])
  } catch {
    throw invalidUrl()
  }
  if (!publicId || /\s/.test(publicId)) throw invalidUrl()

  return {
    publicId,
    canonicalUrl: `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`,
  }
}
