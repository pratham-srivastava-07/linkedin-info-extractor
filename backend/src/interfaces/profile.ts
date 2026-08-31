/**
 * The public contract (docs/api.md). Every key is always present: scalars fall
 * back to `null` and lists to `[]`, never omitted — callers can rely on the shape
 * without existence checks ("field confidence" in CLAUDE.md).
 */
export interface Experience {
  title: string | null
  company: string | null
  duration: string | null
  description: string | null
}

export interface Education {
  school: string | null
  degree: string | null
  duration: string | null
}

export interface Certification {
  name: string | null
  issuer: string | null
}

export interface Profile {
  profileUrl: string
  name: string | null
  headline: string | null
  location: string | null
  about: string | null
  experience: Experience[]
  education: Education[]
  skills: string[]
  certifications: Certification[]
  languages: string[]
  profileImageUrl: string | null
  fetchedAt: string
}
