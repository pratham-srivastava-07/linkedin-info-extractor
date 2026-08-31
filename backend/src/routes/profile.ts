import { Router } from "express"
import { profileController } from "../controllers"
import { requireApiKey } from "../middlewares/apiKey"

export const profileRouter = Router()
profileRouter.post("/", requireApiKey, profileController.extract)
