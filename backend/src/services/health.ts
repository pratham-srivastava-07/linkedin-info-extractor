import { SessionManager, sessionManager } from "../linkedin/sessionManager"
import { PrismaClass } from "../helpers/prisma"

export interface HealthReport {
  status: "ok" | "degraded"
  database: "connected" | "unreachable"
  session: "valid" | "invalid"
}

export class HealthService {
  constructor(private readonly sessions: SessionManager) {}

  /**
   * Checks what would actually break a request: the database, and the upstream
   * session. The session probe only hits LinkedIn when our cached validation has
   * gone stale, so frequent platform health checks stay cheap.
   */
  async check(): Promise<HealthReport> {
    const [databaseUp, sessionValid] = await Promise.all([
      PrismaClass.ping(),
      this.sessions.probe(),
    ])
    return {
      status: databaseUp && sessionValid ? "ok" : "degraded",
      database: databaseUp ? "connected" : "unreachable",
      session: sessionValid ? "valid" : "invalid",
    }
  }
}

export const healthService = new HealthService(sessionManager)
