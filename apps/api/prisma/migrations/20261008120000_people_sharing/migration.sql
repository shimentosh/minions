-- Sharing personal items with people by email (ARCHITECTURE.md §8).
CREATE TYPE "PeoplePermission" AS ENUM ('VIEW', 'EDIT');

CREATE TABLE "item_shares" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "recipientId" UUID,
    "permission" "PeoplePermission" NOT NULL DEFAULT 'VIEW',
    "sealedItemKey" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sealedAt" TIMESTAMP(3),
    "seenAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "item_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "item_shares_itemId_email_key" ON "item_shares"("itemId", "email");
CREATE INDEX "item_shares_ownerId_createdAt_idx" ON "item_shares"("ownerId", "createdAt");
CREATE INDEX "item_shares_email_idx" ON "item_shares"("email");
CREATE INDEX "item_shares_recipientId_idx" ON "item_shares"("recipientId");

ALTER TABLE "item_shares" ADD CONSTRAINT "item_shares_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "vault_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_shares" ADD CONSTRAINT "item_shares_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_shares" ADD CONSTRAINT "item_shares_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Share links may now never expire (a view limit or revoking ends them).
ALTER TABLE "shares" ALTER COLUMN "expiresAt" DROP NOT NULL;
