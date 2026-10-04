-- CreateTable
CREATE TABLE "shares" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "vaultId" UUID NOT NULL,
    "itemId" UUID,
    "label" TEXT NOT NULL,
    "ciphertext" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxViews" INTEGER,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "passphraseSalt" TEXT,
    "accessHash" TEXT,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "includesTotp" BOOLEAN NOT NULL DEFAULT false,
    "lastViewedAt" TIMESTAMP(3),
    "burnedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shares_userId_createdAt_idx" ON "shares"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "shares_expiresAt_idx" ON "shares"("expiresAt");
