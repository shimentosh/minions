-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "webauthnChallenge" TEXT,
ADD COLUMN     "webauthnChallengeExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "security_finding_records" (
    "id" UUID NOT NULL,
    "vaultId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "itemIds" TEXT[],
    "position" INTEGER NOT NULL,

    CONSTRAINT "security_finding_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_snapshots" (
    "vaultId" UUID NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "dirtyAt" TIMESTAMP(3),
    "totalItems" INTEGER NOT NULL,
    "passwordItems" INTEGER NOT NULL,
    "twoFactorEligible" INTEGER NOT NULL,

    CONSTRAINT "security_snapshots_pkey" PRIMARY KEY ("vaultId")
);

-- CreateIndex
CREATE INDEX "security_finding_records_vaultId_type_position_idx" ON "security_finding_records"("vaultId", "type", "position");

-- CreateIndex
CREATE UNIQUE INDEX "security_finding_records_vaultId_key_key" ON "security_finding_records"("vaultId", "key");
