import { ZodError } from "zod"
import { ErrorCode } from "../interfaces/error"

/**
 * Every expected failure is an AppError carrying the exact `error` code that
 * docs/api.md publishes. Anything else escaping to the handler is an internal
 * error and gets scrubbed — callers never see a stack or a driver message.
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly statusCode: number
  /** Sent to the caller. Omitted when api.md documents a bare `{ error }` body. */
  readonly publicMessage?: string
  /** Extra documented fields merged into the body, e.g. `retryAfterSeconds`. */
  readonly meta?: Record<string, unknown>

  constructor(
    code: ErrorCode,
    statusCode: number,
    opts: { publicMessage?: string; meta?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(opts.publicMessage ?? code, { cause: opts.cause })
    this.name = this.constructor.name
    this.code = code
    this.statusCode = statusCode
    this.publicMessage = opts.publicMessage
    this.meta = opts.meta
    Error.captureStackTrace?.(this, this.constructor)
  }
}

export const invalidUrl = (message = "url must be a valid LinkedIn profile URL") =>
  new AppError("invalid_url", 400, { publicMessage: message })

export const unauthorized = () => new AppError("unauthorized", 401)

export const profileNotFound = () => new AppError("profile_not_found", 404)

export const rateLimited = (retryAfterSeconds = 30) =>
  new AppError("rate_limited", 429, { meta: { retryAfterSeconds } })

export const sessionUnavailable = (cause?: unknown) =>
  new AppError("session_unavailable", 503, { cause })

/**
 * The upstream payload no longer matches what the normalizer expects. Carries the
 * raw payload so the handler can log it — that diff against the last known fixture
 * is the documented way to find what moved (docs/notes.md § Troubleshooting).
 */
export class SchemaMismatchError extends AppError {
  readonly rawPayload: unknown
  constructor(detail: string, rawPayload: unknown) {
    super("upstream_schema_mismatch", 502, { cause: new Error(detail) })
    this.name = this.constructor.name
    this.rawPayload = rawPayload
  }
}

/**
 * `express.json()` rejects a body it cannot parse — bad JSON, over the size limit,
 * an unsupported charset — with an http-errors object carrying a 4xx `status` and
 * a `type` like `entity.parse.failed`. It is not a ZodError and not an AppError,
 * so without this it would fall through to a 500 for what is plainly bad input.
 */
const badRequestBodyMessage = (err: unknown): string | null => {
  if (!(err instanceof Error)) return null
  const { type, status, statusCode } = err as Error & {
    type?: unknown
    status?: unknown
    statusCode?: unknown
  }
  if (typeof type !== "string" || !type.startsWith("entity.")) return null
  const code = typeof status === "number" ? status : statusCode
  if (typeof code !== "number" || code < 400 || code >= 500) return null
  return type === "entity.too.large" ? "request body is too large" : "request body must be valid JSON"
}

export const toAppError = (err: unknown): AppError => {
  if (err instanceof AppError) return err
  // A malformed request body reaches us as a ZodError; api.md has exactly one
  // 400 for this endpoint, so it maps onto invalid_url.
  if (err instanceof ZodError)
    return invalidUrl(err.issues.map((i) => i.message).join("; ") || undefined)
  const badBody = badRequestBodyMessage(err)
  if (badBody) return invalidUrl(badBody)
  return new AppError("internal_error", 500, {
    publicMessage: "Something went wrong. Please try again",
    cause: err,
  })
}
