export type ErrorCode =
  | "invalid_url"
  | "unauthorized"
  | "profile_not_found"
  | "rate_limited"
  | "upstream_schema_mismatch"
  | "session_unavailable"
  | "internal_error"

/// The wire shape every error response takes (docs/api.md § Error responses).
export interface ErrorBody {
  error: ErrorCode
  message?: string
  [extra: string]: unknown
}
