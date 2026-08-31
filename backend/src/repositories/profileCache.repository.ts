import { CachedProfile } from "@prisma/client"
import { Prisma } from "@prisma/client"
import { PrismaClass } from "../helpers/prisma"
import { Profile } from "../interfaces/profile"

class ProfileCacheRepository {
  private prisma = PrismaClass.getInstance()

  /** Returns null for a miss *or* a stale entry — callers never see expired data. */
  async findFresh(publicId: string, now = new Date()): Promise<CachedProfile | null> {
    return this.prisma.cachedProfile.findFirst({
      where: { publicId, expiresAt: { gt: now } },
    })
  }

  upsert(
    publicId: string,
    profileUrl: string,
    payload: Profile,
    expiresAt: Date,
  ): Promise<CachedProfile> {
    const entry = {
      profileUrl,
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt: new Date(),
      expiresAt,
    }
    return this.prisma.cachedProfile.upsert({
      where: { publicId },
      create: { publicId, ...entry },
      update: entry,
    })
  }

  deleteExpired(now = new Date()): Promise<{ count: number }> {
    return this.prisma.cachedProfile.deleteMany({ where: { expiresAt: { lte: now } } })
  }
}

export const profileCacheRepository = new ProfileCacheRepository()
export { ProfileCacheRepository }
