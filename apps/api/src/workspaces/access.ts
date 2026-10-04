import type { ItemPermission, WorkspaceRole } from "@minions/core";
import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import type { Prisma } from "../generated/prisma/client";

/**
 * Every workspace route asks this service who the caller is in the workspace
 * and what they may do with an item. The workspace comes from the URL, and
 * the caller's identity only from the session; nothing in a request body is
 * trusted for authorisation.
 *
 * Who can open a workspace item:
 *  - a member holding a grant for it (VIEW or MANAGE), or
 *  - any confirmed member, when the item is shared with the whole workspace.
 * Owners and admins manage every item they can open. Nobody, owners included,
 * can open an item that is neither granted to them nor shared with everyone:
 * they hold no key for it, and the server returns no ciphertext for it.
 *
 * A workspace the caller does not belong to answers 404, as if it did not exist.
 */

export interface Membership {
  workspace: { id: string; name: string; vaultId: string; rekeyNeeded: boolean };
  member: {
    id: string;
    role: WorkspaceRole;
    status: "INVITED" | "ACCEPTED" | "CONFIRMED";
    protectedWorkspaceKey: string | null;
  };
}

export const isAdmin = (role: WorkspaceRole) => role === "OWNER" || role === "ADMIN";

const RANK: Record<ItemPermission, number> = { VIEW: 1, MANAGE: 2 };

/** Items the user can open, inside one workspace vault. */
export function visibleWhere(userId: string): Prisma.VaultItemWhereInput {
  return { OR: [{ grants: { some: { userId } } }, { workspaceShared: true }] };
}

/** Items the user may edit, share and delete. */
export function manageWhere(userId: string, role: WorkspaceRole): Prisma.VaultItemWhereInput {
  return isAdmin(role)
    ? visibleWhere(userId)
    : { grants: { some: { userId, permission: "MANAGE" } } };
}

export function permissionOf(
  item: { workspaceShared: boolean; grants: { userId: string; permission: ItemPermission }[] },
  userId: string,
  role: WorkspaceRole,
): ItemPermission | null {
  const grant = item.grants.find((g) => g.userId === userId);
  if (!grant && !item.workspaceShared) return null;
  if (isAdmin(role)) return "MANAGE";
  return grant?.permission ?? "VIEW";
}

@Injectable()
export class WorkspaceAccess {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's membership. `confirmed`: they must hold the workspace key already. */
  async membership(
    auth: AuthContext,
    workspaceId: string,
    opts: { confirmed?: boolean; admin?: boolean; owner?: boolean } = {},
  ): Promise<Membership> {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: auth.userId } },
      include: {
        workspace: { select: { id: true, name: true, vaultId: true, rekeyNeeded: true } },
      },
    });
    if (!member || member.status === "INVITED") throw new NotFoundException("Workspace not found");
    if ((opts.confirmed ?? true) && member.status !== "CONFIRMED")
      throw new ForbiddenException({
        message: "An admin has not confirmed your membership yet",
        code: "MEMBERSHIP_PENDING",
      });
    if (opts.owner && member.role !== "OWNER")
      throw new ForbiddenException("Only the workspace owner can do this");
    if (opts.admin && !isAdmin(member.role))
      throw new ForbiddenException("Only workspace owners and admins can do this");
    return {
      workspace: member.workspace,
      member: {
        id: member.id,
        role: member.role,
        status: member.status,
        protectedWorkspaceKey: member.protectedWorkspaceKey,
      },
    };
  }

  /**
   * The context the shared item service runs with: the workspace's vault, and
   * the workspace id so the activity lands in its audit log. Only built after
   * `membership` succeeded.
   */
  scoped(auth: AuthContext, m: Membership): AuthContext {
    return { ...auth, vaultId: m.workspace.vaultId, workspaceId: m.workspace.id };
  }

  /**
   * One item with the caller's permission, or 404 when they cannot open it
   * (whether or not it exists). `need: "MANAGE"` turns a view-only caller into 403.
   */
  async item(auth: AuthContext, m: Membership, itemId: string, need: ItemPermission = "VIEW") {
    const item = await this.prisma.vaultItem.findFirst({
      where: { id: itemId, vaultId: m.workspace.vaultId, ...visibleWhere(auth.userId) },
      include: { grants: { select: { userId: true, permission: true, protectedItemKey: true } } },
    });
    const permission = item ? permissionOf(item, auth.userId, m.member.role) : null;
    if (!item || !permission) throw new NotFoundException("Credential not found");
    // Items in the trash are for the people who can restore or purge them.
    const required: ItemPermission = item.deletedAt ? "MANAGE" : need;
    if (RANK[permission] < RANK[required]) {
      if (item.deletedAt) throw new NotFoundException("Credential not found");
      throw new ForbiddenException("You can use this credential but not change it");
    }
    return { item, permission };
  }

  /** Every user id must be a confirmed member of this workspace. */
  async assertConfirmedMembers(workspaceId: string, userIds: string[]) {
    const unique = [...new Set(userIds)];
    if (!unique.length) return new Map<string, { email: string; role: WorkspaceRole }>();
    const rows = await this.prisma.workspaceMember.findMany({
      where: { workspaceId, userId: { in: unique }, status: "CONFIRMED" },
      select: { userId: true, email: true, role: true },
    });
    if (rows.length !== unique.length)
      throw new NotFoundException({
        message: "Not a confirmed member of this workspace",
        code: "MEMBER_NOT_FOUND",
      });
    return new Map(rows.map((r) => [r.userId!, { email: r.email, role: r.role }]));
  }
}
