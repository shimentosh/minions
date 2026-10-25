-- Archived pages and vault items: hidden by default, never deleted. Additive only.
ALTER TABLE "pages" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "vault_items" ADD COLUMN "archivedAt" TIMESTAMP(3);
