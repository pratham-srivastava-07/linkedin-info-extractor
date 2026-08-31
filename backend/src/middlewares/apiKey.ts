import { NextFunction, Request, Response } from "express"
import { timingSafeEqual } from "node:crypto"
import { env } from "../config/env"
import { unauthorized } from "../utils/AppError"

const matches = (candidate: string, expected: string): boolean => {
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on length mismatch, so compare lengths first — the
  // length of an API key is not the secret.
  return a.length === b.length && timingSafeEqual(a, b)
}

/** `Authorization: Bearer <API_KEY>` on everything except /health (docs/api.md). */
export const requireApiKey = (req: Request, _res: Response, next: NextFunction) => {
  const [scheme, token] = (req.headers.authorization ?? "").split(" ")
  if (scheme !== "Bearer" || !token || !matches(token, env.API_KEY)) return next(unauthorized())
  next()
}
