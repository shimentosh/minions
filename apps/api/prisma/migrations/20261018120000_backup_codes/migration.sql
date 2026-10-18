-- Forgotten master password: backup codes that keep the vault replace the reset that deleted it.
DROP TABLE "account_resets";

CREATE TABLE "backup_codes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "proofHash" TEXT NOT NULL,
    "protectedUserKey" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "backup_codes_proofHash_key" ON "backup_codes"("proofHash");
CREATE INDEX "backup_codes_userId_idx" ON "backup_codes"("userId");

ALTER TABLE "backup_codes" ADD CONSTRAINT "backup_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
