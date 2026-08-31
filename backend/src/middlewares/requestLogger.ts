import { NextFunction, Request, Response } from "express"
import { randomUUID } from "node:crypto"

/**
 * One line per request: id, method, path, status, duration.
 *
 * Hand-rolled rather than morgan, because the whole requirement is a single
 * `console.log` in a known format and the one rule that actually matters here is
 * a *negative* one: **nothing header-derived is ever logged.** The API key rides
 * in `Authorization` and the upstream cookies ride in `cookie`, so a logger that
 * dumps headers would put both in the log file of every deployment. This one only
 * ever touches method, path, status and the clock.
 *
 * The query string is stripped too. This API takes no query parameters, so
 * nothing is lost — but a caller who puts a key in one anyway (`?api_key=…`, an
 * old habit) must not have it persisted by us.
 */

const REQUEST_ID_HEADER = "x-request-id"
/** Ids come from outside, so cap and filter before echoing one back. */
const SAFE_REQUEST_ID = /^[\w.:-]{1,64}$/

const pathOf = (url: string): string => url.split("?")[0] || "/"

const incomingRequestId = (req: Request): string | null => {
  const header = req.headers[REQUEST_ID_HEADER]
  const value = Array.isArray(header) ? header[0] : header
  return value && SAFE_REQUEST_ID.test(value) ? value : null
}

export interface RequestLoggerOptions {
  /** Injected so tests can assert the line without capturing stdout. */
  log?: (line: string) => void
  now?: () => number
  newId?: () => string
}

export const requestLogger = ({
  log = (line) => console.log(line),
  now = () => Date.now(),
  newId = () => randomUUID(),
}: RequestLoggerOptions = {}) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = incomingRequestId(req) ?? newId()
    // Handed back to the caller and stashed for the error handler, so a log line
    // and the 500 a user is complaining about can be tied together.
    res.locals.requestId = requestId
    res.setHeader("X-Request-Id", requestId)

    const startedAt = now()
    const method = req.method
    const path = pathOf(req.originalUrl)

    // `close` always fires; `finish` does not when the client hangs up mid
    // response, and an abandoned request is exactly the one worth seeing.
    res.once("close", () => {
      const duration = now() - startedAt
      const outcome = res.writableEnded ? String(res.statusCode) : "aborted"
      log(`[http] ${requestId} ${method} ${path} ${outcome} ${duration}ms`)
    })

    next()
  }
}
