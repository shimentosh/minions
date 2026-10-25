-- CreateTable
CREATE TABLE "pages" (
    "id" UUID NOT NULL,
    "vaultId" UUID NOT NULL,
    "parentId" UUID,
    "position" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'page',
    "protectedKey" TEXT NOT NULL,
    "metaEnc" TEXT NOT NULL,
    "contentEnc" TEXT,
    "keyGen" INTEGER NOT NULL DEFAULT 1,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_versions" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "metaEnc" TEXT NOT NULL,
    "contentEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_files" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "vaultId" UUID NOT NULL,
    "metaEnc" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pages_vaultId_deletedAt_idx" ON "pages"("vaultId", "deletedAt");

-- CreateIndex
CREATE INDEX "pages_parentId_idx" ON "pages"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "page_versions_pageId_revision_key" ON "page_versions"("pageId", "revision");

-- CreateIndex
CREATE INDEX "page_files_pageId_idx" ON "page_files"("pageId");

-- CreateIndex
CREATE INDEX "page_files_vaultId_idx" ON "page_files"("vaultId");

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_files" ADD CONSTRAINT "page_files_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
