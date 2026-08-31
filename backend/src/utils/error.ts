import { NextFunction, Request, Response } from "express"
import { AppError, SchemaMismatchError, toAppError } from "./AppError"
import { ErrorBody } from "../interfaces/error"
import { env } from "../config/env"

export const globalErrorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const appError = toAppError(err)
  // Ties this failure to the one-line request log for the same request.
  const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : "-"

  if (appError instanceof SchemaMismatchError) {
    // The raw payload is the only artifact that makes a mapping break diagnosable.
    console.error(`[upstream_schema_mismatch] ${requestId}`, appError.cause, {
      rawPayload: JSON.stringify(appError.rawPayload)?.slice(0, 20_000),
    })
  } else if (appError.statusCode >= 500) {
    console.error(`[${appError.code}] ${requestId}`, appError.cause ?? appError)
  }

  const body: ErrorBody = { error: appError.code }
  if (appError.publicMessage) body.message = appError.publicMessage
  if (appError.meta) Object.assign(body, appError.meta)
  if (appError.code === "rate_limited" && typeof appError.meta?.retryAfterSeconds === "number") {
    res.setHeader("Retry-After", String(appError.meta.retryAfterSeconds))
  }
  if (env.NODE_ENV === "development" && appError.statusCode >= 500) {
    body.stack = appError.stack
  }

  return res.status(appError.statusCode).json(body)
}

/** 404 for anything not routed — kept in the api.md error vocabulary. */
export const notFoundHandler = (_req: Request, res: Response) =>
  res.status(404).json({ error: "profile_not_found", message: "Unknown endpoint" })

export { AppError }
