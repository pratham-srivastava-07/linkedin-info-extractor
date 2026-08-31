import { NextFunction, Request, Response } from "express"
import { ProfileService } from "../services/profile"
import { extractProfileSchema } from "../validators"
import { toAppError } from "../utils/AppError"

export class ProfileController {
  constructor(private readonly service: ProfileService) {}

  // Arrow-fn properties keep `this` bound when handed to Express routes.
  extract = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // A request with no body at all reaches Express 5 as `undefined`; treating
      // it as `{}` lets the schema report the missing `url` instead of the type.
      const { url } = extractProfileSchema.parse(req.body ?? {})
      const { profile, cacheHit } = await this.service.extract(url)
      // api.md publishes the Profile object as the whole body — no envelope.
      res.status(200).setHeader("X-Cache", cacheHit ? "HIT" : "MISS")
      res.json(profile)
    } catch (err) {
      next(toAppError(err))
    }
  }
}
