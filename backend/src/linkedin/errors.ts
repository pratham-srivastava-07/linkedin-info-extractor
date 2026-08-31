/**
 * Internal signals from the transport layer. These are deliberately NOT AppErrors:
 * the session manager gets first refusal on them (it may retry with a fresh
 * session) and only then are they translated to the public error vocabulary.
 */
export class UpstreamAuthError extends Error {
  constructor(readonly status: number) {
    super(`Upstream rejected the session (HTTP ${status})`)
    this.name = "UpstreamAuthError"
  }
}

export class UpstreamNotFoundError extends Error {
  constructor(readonly publicId: string) {
    super(`Profile not found or not visible to this session: ${publicId}`)
    this.name = "UpstreamNotFoundError"
  }
}

export class UpstreamRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Upstream rate limited us (retry in ${retryAfterSeconds}s)`)
    this.name = "UpstreamRateLimitError"
  }
}

/**
 * Upstream answered HTTP 410 Gone: the endpoint itself has been retired.
 *
 * This exists as its own type because of a real misdiagnosis. The legacy
 * `/identity/profiles/{id}/profileView` surface (and the rest of that family)
 * now returns 410, and while 410 fell through to a generic "unavailable" it
 * surfaced as `503 session_unavailable` — so a *retired endpoint* looked
 * exactly like a *dead cookie*, and hours went into re-capturing credentials
 * that were never the problem. A retired endpoint must never masquerade as an
 * expired session: nothing about the credential can fix it, only a code change
 * pointing at a surface that still exists.
 */
export class UpstreamGoneError extends Error {
  constructor(readonly path: string) {
    super(
      `Upstream returned HTTP 410 Gone for ${path}: that endpoint has been retired by LinkedIn. ` +
        "This is not a session problem — re-capturing cookies will not help; the client must target a surface that still exists.",
    )
    this.name = "UpstreamGoneError"
  }
}

export class UpstreamUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "UpstreamUnavailableError"
  }
}
