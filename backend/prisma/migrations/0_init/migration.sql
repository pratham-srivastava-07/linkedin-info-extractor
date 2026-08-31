-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "memberUrn" TEXT,
    "lastValidatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cached_profiles" (
    "publicId" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cached_profiles_pkey" PRIMARY KEY ("publicId")
);

-- CreateTable
CREATE TABLE "extraction_jobs" (
    "id" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extraction_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_fingerprint_key" ON "sessions"("fingerprint");

-- CreateIndex
CREATE INDEX "cached_profiles_expiresAt_idx" ON "cached_profiles"("expiresAt");

-- CreateIndex
CREATE INDEX "extraction_jobs_publicId_createdAt_idx" ON "extraction_jobs"("publicId", "createdAt");

-- CreateIndex
CREATE INDEX "extraction_jobs_status_createdAt_idx" ON "extraction_jobs"("status", "createdAt");

