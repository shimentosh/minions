-- Vault key rotation: each row records the key generation it is encrypted under,
-- so an interrupted rotation can resume where it stopped.
ALTER TABLE "vaults" ADD COLUMN "keyGen" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "pendingProtectedKey" TEXT;

ALTER TABLE "vault_items" ADD COLUMN "keyGen" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "notes" ADD COLUMN "keyGen" INTEGER NOT NULL DEFAULT 1;
