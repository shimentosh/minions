-- Trigram search over safe metadata only. Ciphertext columns are never indexed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "notes_title_trgm" ON "notes" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "vault_items_search_trgm" ON "vault_items" USING GIN ("searchText" gin_trgm_ops);
