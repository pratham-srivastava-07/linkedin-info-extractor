import { healthService, profileService } from "../services"
import { HealthController } from "./health"
import { ProfileController } from "./profile"

export const profileController = new ProfileController(profileService)
export const healthController = new HealthController(healthService)
export { ProfileController, HealthController }
