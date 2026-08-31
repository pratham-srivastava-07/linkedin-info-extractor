import { ExtractionJob, JobStatus } from "@prisma/client"
import { PrismaClass } from "../helpers/prisma"

export interface RecordJobInput {
  profileUrl: string
  publicId: string
  status: JobStatus
  cacheHit: boolean
  durationMs: number
  errorCode?: string
  errorMessage?: string
}

class ExtractionJobRepository {
  private prisma = PrismaClass.getInstance()

  record(input: RecordJobInput): Promise<ExtractionJob> {
    return this.prisma.extractionJob.create({ data: input })
  }

  recent(limit = 50): Promise<ExtractionJob[]> {
    return this.prisma.extractionJob.findMany({ orderBy: { createdAt: "desc" }, take: limit })
  }
}

export const extractionJobRepository = new ExtractionJobRepository()
export { ExtractionJobRepository }
