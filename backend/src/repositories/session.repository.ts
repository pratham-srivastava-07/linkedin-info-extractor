import { Session, SessionStatus } from "@prisma/client"
import { PrismaClass } from "../helpers/prisma"

class SessionRepository {
  private prisma = PrismaClass.getInstance()

  findByFingerprint(fingerprint: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { fingerprint } })
  }

  markValidated(fingerprint: string, memberUrn: string | null, expiresAt: Date): Promise<Session> {
    const validated = {
      status: SessionStatus.ACTIVE,
      memberUrn,
      lastValidatedAt: new Date(),
      lastError: null,
      expiresAt,
    }
    return this.prisma.session.upsert({
      where: { fingerprint },
      create: { fingerprint, ...validated },
      update: validated,
    })
  }

  markExpired(fingerprint: string, lastError: string): Promise<Session> {
    const expired = {
      status: SessionStatus.EXPIRED,
      lastError,
      lastValidatedAt: new Date(),
      expiresAt: new Date(),
    }
    return this.prisma.session.upsert({
      where: { fingerprint },
      create: { fingerprint, ...expired },
      update: expired,
    })
  }
}

export const sessionRepository = new SessionRepository()
export { SessionRepository }
