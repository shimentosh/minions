-- Forgotten master password: single-use links that reset the account. The vault is deleted, not recovered.
CREATE TABLE "account_resets" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_resets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_resets_tokenHash_key" ON "account_resets"("tokenHash");
CREATE INDEX "account_resets_userId_idx" ON "account_resets"("userId");

ALTER TABLE "account_resets" ADD CONSTRAINT "account_resets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
