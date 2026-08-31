import { Router } from "express"
import { healthRouter } from "./health"
import { profileRouter } from "./profile"

export const router = Router()
router.use("/profile", profileRouter)
router.use("/health", healthRouter)
