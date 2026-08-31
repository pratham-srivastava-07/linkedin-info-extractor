import { Router } from "express"
import { healthController } from "../controllers"

// Deliberately unauthenticated — api.md exempts /health, and a health check that
// needs a credential is useless to a deployment platform.
export const healthRouter = Router()
healthRouter.get("/", healthController.check)
