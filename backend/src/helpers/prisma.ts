import { PrismaClient } from "@prisma/client"

export class PrismaClass {
  private static instance: PrismaClient
  static getInstance(): PrismaClient {
    if (!this.instance) this.instance = new PrismaClient()
    return this.instance
  }

  /**
   * Hands the pooled connections back on shutdown. No-op when nothing ever
   * connected, so a boot that fails before the first query still exits cleanly.
   */
  static async disconnect(): Promise<void> {
    if (this.instance) await this.instance.$disconnect()
  }

  /** Used by /health to prove the database is actually reachable, not just configured. */
  static async ping(): Promise<boolean> {
    try {
      await this.getInstance().$queryRaw`SELECT 1`
      return true
    } catch {
      return false
    }
  }
}
