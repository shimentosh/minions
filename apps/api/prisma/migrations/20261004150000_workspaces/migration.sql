-- Workspaces and end-to-end encrypted sharing. Additive only: new tables, and
-- new columns that are nullable or have defaults. Existing rows are unchanged.

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('INVITED', 'ACCEPTED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ItemPermission" AS ENUM ('VIEW', 'MANAGE');

-- AlterTable
ALTER TABLE "activity_logs" ADD COLUMN     "workspaceId" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "protectedPrivateKey" TEXT,
ADD COLUMN     "publicKey" TEXT;

-- AlterTable
ALTER TABLE "vault_items" ADD COLUMN     "createdById" UUID,
ADD COLUMN     "protectedItemKey" TEXT,
ADD COLUMN     "rekeyNeeded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "workspaceShared" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "vaults" ALTER COLUMN "userId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "vaultId" UUID NOT NULL,
    "createdById" UUID,
    "rekeyNeeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID,
    "email" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "status" "MemberStatus" NOT NULL,
    "protectedWorkspaceKey" TEXT,
    "invitedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_item_grants" (
    "itemId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "permission" "ItemPermission" NOT NULL,
    "protectedItemKey" TEXT NOT NULL,
    "grantedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_item_grants_pkey" PRIMARY KEY ("itemId","userId")
);

-- CreateTable
CREATE TABLE "workspace_item_favorites" (
    "itemId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_item_favorites_pkey" PRIMARY KEY ("itemId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_vaultId_key" ON "workspaces"("vaultId");

-- CreateIndex
CREATE INDEX "workspace_members_email_status_idx" ON "workspace_members"("email", "status");

-- CreateIndex
CREATE INDEX "workspace_members_userId_idx" ON "workspace_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspaceId_email_key" ON "workspace_members"("workspaceId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspaceId_userId_key" ON "workspace_members"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "workspace_item_grants_workspaceId_userId_idx" ON "workspace_item_grants"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "workspace_item_grants_userId_idx" ON "workspace_item_grants"("userId");

-- CreateIndex
CREATE INDEX "workspace_item_favorites_userId_idx" ON "workspace_item_favorites"("userId");

-- CreateIndex
CREATE INDEX "activity_logs_workspaceId_createdAt_idx" ON "activity_logs"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_item_grants" ADD CONSTRAINT "workspace_item_grants_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "vault_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_item_grants" ADD CONSTRAINT "workspace_item_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_item_favorites" ADD CONSTRAINT "workspace_item_favorites_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "vault_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_item_favorites" ADD CONSTRAINT "workspace_item_favorites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

