import { NextFunction, Request, Response } from "express"
import { HealthService } from "../services/health"
import { toAppError } from "../utils/AppError"

export class HealthController {
  constructor(private readonly service: HealthService) {}

  check = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const report = await this.service.check()
      // 503 when degraded, so a platform health check takes the instance out of
      // rotation instead of routing traffic at a dead session.
      res.status(report.status === "ok" ? 200 : 503).json(report)
    } catch (err) {
      next(toAppError(err))
    }
  }
}
