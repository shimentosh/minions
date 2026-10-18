-- Email reset that keeps the vault: the server holds the user key, encrypted with its own key.
ALTER TABLE "users" ADD COLUMN "emailRecovery" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "recoveryKeyEnc" TEXT;

CREATE TABLE "account_resets" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "openedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_resets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_resets_tokenHash_key" ON "account_resets"("tokenHash");
CREATE INDEX "account_resets_userId_idx" ON "account_resets"("userId");

ALTER TABLE "account_resets" ADD CONSTRAINT "account_resets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
