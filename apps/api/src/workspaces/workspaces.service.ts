import { createPublicKey, randomUUID } from "node:crypto";
import {
  isEnvelope,
  type MemberProfile,
  type WorkspaceDetail,
  type WorkspaceInvitation,
  type WorkspaceMember,
  type WorkspaceSummary,
} from "@minions/core";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ActivityService } from "../activity/activity.service";
import type { AuthContext } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  isAdmin,
  type Membership,
  manageWhere,
  permissionOf,
  visibleWhere,
  WorkspaceAccess,
} from "./access";
import type {
  AuditQuery,
  ChangeRoleDto,
  ConfirmMemberDto,
  CreateWorkspaceDto,
  FolderDto,
  InviteDto,
  KeyPairDto,
  RekeyWorkspaceDto,
} from "./workspaces.dto";

type MemberRow = Prisma.WorkspaceMemberGetPayload<{
  include: { user: { select: { name: true; publicKey: true } } };
}>;

function toMember(m: MemberRow): WorkspaceMember {
  return {
    id: m.id,
    userId: m.userId,
    email: m.email,
    name: m.user?.name ?? null,
    role: m.role,
    status: m.status,
    // The key matters only once they joined; before that there is none to show.
    publicKey: m.status === "INVITED" ? null : (m.user?.publicKey ?? null),
    invitedAt: m.createdAt.toISOString(),
    confirmedAt: m.confirmedAt?.toISOString() ?? null,
  };
}

function emailNotVerified(message: string) {
  return new ForbiddenException({ message, code: "EMAIL_NOT_VERIFIED" });
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccess,
    private readonly activity: ActivityService,
  ) {}

  // ─── Sharing key pair ──────────────────────────────────────────────────────

  /**
   * Stores the caller's public key and wrapped private key, once. Replacing a
   * key pair later would let a stolen session swap in a key it controls, so
   * it is refused.
   */
  async setKeyPair(auth: AuthContext, dto: KeyPairDto) {
    let ok = false;
    try {
      const key = createPublicKey({
        key: Buffer.from(dto.publicKey, "base64"),
        format: "der",
        type: "spki",
      });
      ok = key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails?.modulusLength === 3072;
    } catch {
      ok = false;
    }
    if (!ok) throw new BadRequestException("Expected an RSA-3072 public key");
    if (!isEnvelope(dto.protectedPrivateKey))
      throw new BadRequestException("The private key must be encrypted on the client");
    const { count } = await this.prisma.user.updateMany({
      where: { id: auth.userId, publicKey: null },
      data: { publicKey: dto.publicKey, protectedPrivateKey: dto.protectedPrivateKey },
    });
    if (count === 0) throw new ConflictException("Sharing keys are already set up");
  }

  private async requireKeyPair(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, publicKey: true },
    });
    if (!user.publicKey)
      throw new BadRequestException({
        message: "Unlock your vault once to set up sharing keys, then try again",
        code: "KEYPAIR_REQUIRED",
      });
    return user;
  }

  // ─── Workspaces ────────────────────────────────────────────────────────────

  async list(auth: AuthContext): Promise<WorkspaceSummary[]> {
    const rows = await this.prisma.workspaceMember.findMany({
      where: { userId: auth.userId, status: { in: ["ACCEPTED", "CONFIRMED"] } },
      include: {
        workspace: {
          include: { _count: { select: { members: { where: { status: { not: "INVITED" } } } } } },
        },
      },
      orderBy: { workspace: { name: "asc" } },
    });
    return rows.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      role: m.role,
      status: m.status,
      memberCount: m.workspace._count.members,
      createdAt: m.workspace.createdAt.toISOString(),
    }));
  }

  async create(auth: AuthContext, dto: CreateWorkspaceDto): Promise<WorkspaceSummary> {
    const user = await this.requireKeyPair(auth.userId);
    if (await this.prisma.workspace.findUnique({ where: { id: dto.id }, select: { id: true } }))
      throw new ConflictException("Workspace id already exists");
    const name = dto.name.trim();
    const ws = await this.prisma.$transaction(async (tx) => {
      const vault = await tx.vault.create({
        // Workspace items have per-item keys; the vault itself has none.
        data: { id: randomUUID(), userId: null, name, protectedKey: "-" },
      });
      const workspace = await tx.workspace.create({
        data: { id: dto.id, name, vaultId: vault.id, createdById: auth.userId },
      });
      await tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: auth.userId,
          email: user.email,
          role: "OWNER",
          status: "CONFIRMED",
          protectedWorkspaceKey: dto.protectedWorkspaceKey,
          acceptedAt: new Date(),
          confirmedAt: new Date(),
        },
      });
      return workspace;
    });
    await this.activity.log({ ...auth, workspaceId: ws.id }, "workspace.created", {
      metadata: { workspace: name },
    });
    return {
      id: ws.id,
      name: ws.name,
      role: "OWNER",
      status: "CONFIRMED",
      memberCount: 1,
      createdAt: ws.createdAt.toISOString(),
    };
  }

  async get(auth: AuthContext, workspaceId: string): Promise<WorkspaceDetail> {
    const m = await this.access.membership(auth, workspaceId, { confirmed: false });
    const [memberCount, pending, ws, needRekey] = await Promise.all([
      this.prisma.workspaceMember.count({ where: { workspaceId, status: { not: "INVITED" } } }),
      isAdmin(m.member.role)
        ? this.prisma.workspaceMember.count({ where: { workspaceId, status: "ACCEPTED" } })
        : 0,
      this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
      m.member.status === "CONFIRMED"
        ? this.prisma.vaultItem.count({
            where: {
              vaultId: m.workspace.vaultId,
              rekeyNeeded: true,
              deletedAt: null,
              ...manageWhere(auth.userId, m.member.role),
            },
          })
        : 0,
    ]);
    return {
      id: ws.id,
      name: ws.name,
      role: m.member.role,
      status: m.member.status,
      memberCount,
      createdAt: ws.createdAt.toISOString(),
      protectedWorkspaceKey: m.member.protectedWorkspaceKey,
      pendingConfirmations: pending,
      rekeyNeeded: isAdmin(m.member.role) && ws.rekeyNeeded,
      itemsNeedingRekey: needRekey,
    };
  }

  async rename(auth: AuthContext, workspaceId: string, name: string) {
    const m = await this.access.membership(auth, workspaceId, { admin: true });
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { name: name.trim() } });
    await this.prisma.vault.update({
      where: { id: m.workspace.vaultId },
      data: { name: name.trim() },
    });
    await this.activity.log(this.access.scoped(auth, m), "workspace.renamed", {
      metadata: { from: m.workspace.name, to: name.trim() },
    });
  }

  /** Deletes the workspace, its vault and every credential in it. Owner only. */
  async remove(auth: AuthContext, workspaceId: string) {
    const m = await this.access.membership(auth, workspaceId, { owner: true });
    await this.activity.log(this.access.scoped(auth, m), "workspace.deleted", {
      metadata: { workspace: m.workspace.name },
    });
    // The vault cascades to the workspace, its members, items, grants and folders.
    await this.prisma.vault.delete({ where: { id: m.workspace.vaultId } });
  }

  // ─── Invitations ───────────────────────────────────────────────────────────

  /**
   * Invites an email address. Whether it has an account is not revealed: the
   * invitation waits until someone signs in with that email and accepts it.
   */
  async invite(auth: AuthContext, workspaceId: string, dto: InviteDto): Promise<WorkspaceMember> {
    const m = await this.access.membership(auth, workspaceId, { admin: true });
    if (dto.role === "ADMIN" && m.member.role !== "OWNER")
      throw new ForbiddenException("Only the owner can invite admins");
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_email: { workspaceId, email } },
    });
    if (existing) throw new ConflictException("Already invited or a member");
    const row = await this.prisma.workspaceMember.create({
      data: { workspaceId, email, role: dto.role, status: "INVITED", invitedById: auth.userId },
      include: { user: { select: { name: true, publicKey: true } } },
    });
    await this.activity.log(this.access.scoped(auth, m), "workspace.member_invited", {
      metadata: { member: email, role: dto.role },
    });
    return toMember(row);
  }

  async myInvitations(auth: AuthContext): Promise<WorkspaceInvitation[]> {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { email: true, emailVerifiedAt: true },
    });
    // Invitations go to an address; until this account proves it owns that
    // address it sees none of them (not even which workspaces exist).
    if (!me.emailVerifiedAt) return [];
    const rows = await this.prisma.workspaceMember.findMany({
      where: { email: me.email, status: "INVITED", userId: null },
      include: { workspace: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
    const inviterIds = [...new Set(rows.map((r) => r.invitedById).filter((x): x is string => !!x))];
    const inviters = await this.prisma.user.findMany({
      where: { id: { in: inviterIds } },
      select: { id: true, name: true },
    });
    const names = new Map(inviters.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace.id,
      workspaceName: r.workspace.name,
      role: r.role,
      invitedBy: r.invitedById ? (names.get(r.invitedById) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private async ownInvitation(auth: AuthContext, memberId: string) {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { email: true, publicKey: true, emailVerifiedAt: true },
    });
    if (!me.emailVerifiedAt)
      throw emailNotVerified("Confirm your email address to join workspaces");
    const invite = await this.prisma.workspaceMember.findFirst({
      where: { id: memberId, email: me.email, status: "INVITED", userId: null },
    });
    if (!invite) throw new NotFoundException("Invitation not found");
    return { invite, me };
  }

  /** Joins as ACCEPTED. An admin then confirms, which hands over the workspace key. */
  async accept(auth: AuthContext, memberId: string) {
    const { invite, me } = await this.ownInvitation(auth, memberId);
    if (!me.publicKey)
      throw new BadRequestException({
        message: "Unlock your vault once to set up sharing keys, then try again",
        code: "KEYPAIR_REQUIRED",
      });
    await this.prisma.workspaceMember.update({
      where: { id: invite.id },
      data: { userId: auth.userId, status: "ACCEPTED", acceptedAt: new Date() },
    });
    await this.activity.log(
      { ...auth, workspaceId: invite.workspaceId },
      "workspace.member_joined",
    );
    return { workspaceId: invite.workspaceId };
  }

  async decline(auth: AuthContext, memberId: string) {
    const { invite } = await this.ownInvitation(auth, memberId);
    await this.prisma.workspaceMember.delete({ where: { id: invite.id } });
    await this.activity.log(
      { ...auth, workspaceId: invite.workspaceId },
      "workspace.invitation_declined",
    );
  }

  // ─── Members ───────────────────────────────────────────────────────────────

  async members(auth: AuthContext, workspaceId: string): Promise<WorkspaceMember[]> {
    const m = await this.access.membership(auth, workspaceId);
    const rows = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { name: true, publicKey: true } } },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    });
    // Pending invitations are an admin matter.
    return rows.filter((r) => r.status !== "INVITED" || isAdmin(m.member.role)).map(toMember);
  }

  private async target(workspaceId: string, memberId: string) {
    const t = await this.prisma.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
    });
    if (!t) throw new NotFoundException("Member not found");
    return t;
  }

  /**
   * The admin's client sealed the workspace key to the member's public key
   * (after comparing fingerprints, ideally). From now on they can open
   * everything shared with the whole workspace, and receive item grants.
   */
  async confirm(auth: AuthContext, workspaceId: string, memberId: string, dto: ConfirmMemberDto) {
    const m = await this.access.membership(auth, workspaceId, { admin: true });
    const t = await this.target(workspaceId, memberId);
    if (t.status !== "ACCEPTED")
      throw new BadRequestException("This member is not waiting for confirmation");
    // Defence in depth: acceptance already required it, but the address must
    // still be proven when the workspace key is handed over.
    const who = t.userId
      ? await this.prisma.user.findUnique({
          where: { id: t.userId },
          select: { emailVerifiedAt: true, email: true },
        })
      : null;
    if (!who?.emailVerifiedAt || who.email !== t.email)
      throw emailNotVerified("This member has not confirmed their email address");
    await this.prisma.workspaceMember.update({
      where: { id: t.id },
      data: {
        status: "CONFIRMED",
        protectedWorkspaceKey: dto.protectedWorkspaceKey,
        confirmedAt: new Date(),
      },
    });
    await this.activity.log(this.access.scoped(auth, m), "workspace.member_confirmed", {
      metadata: { member: t.email },
    });
  }

  async changeRole(auth: AuthContext, workspaceId: string, memberId: string, dto: ChangeRoleDto) {
    const m = await this.access.membership(auth, workspaceId, { owner: true });
    const t = await this.target(workspaceId, memberId);
    if (t.role === "OWNER") throw new BadRequestException("The owner's role cannot change");
    await this.prisma.workspaceMember.update({ where: { id: t.id }, data: { role: dto.role } });
    await this.activity.log(this.access.scoped(auth, m), "workspace.role_changed", {
      metadata: { member: t.email, from: t.role, to: dto.role },
    });
  }

  /** Removes a member or cancels an invitation. */
  async removeMember(auth: AuthContext, workspaceId: string, memberId: string) {
    const m = await this.access.membership(auth, workspaceId, { admin: true });
    const t = await this.target(workspaceId, memberId);
    if (t.role === "OWNER") throw new ForbiddenException("The owner cannot be removed");
    if (t.userId === auth.userId) throw new BadRequestException("Use leave to remove yourself");
    if (t.role === "ADMIN" && m.member.role !== "OWNER")
      throw new ForbiddenException("Only the owner can remove an admin");
    const result = await this.revoke(m, t);
    await this.activity.log(this.access.scoped(auth, m), "workspace.member_removed", {
      metadata: { member: t.email, count: result.deleted },
    });
    return result;
  }

  async leave(auth: AuthContext, workspaceId: string) {
    const m = await this.access.membership(auth, workspaceId, { confirmed: false });
    if (m.member.role === "OWNER")
      throw new BadRequestException("The owner cannot leave; delete the workspace instead");
    const t = await this.target(workspaceId, m.member.id);
    const result = await this.revoke(m, t);
    await this.activity.log(this.access.scoped(auth, m), "workspace.member_left", {
      metadata: { count: result.deleted },
    });
    return result;
  }

  /**
   * Ends a membership in one transaction: the server stops serving the
   * member anything at once. Keys they held cannot be taken back, so every
   * item they could open is flagged for re-keying, and so is the workspace
   * key if they had it. Items only they could open are deleted, since nobody
   * else holds a key for them; items left without a manager hand MANAGE to
   * the people who still hold them.
   */
  private async revoke(m: Membership, t: { id: string; userId: string | null; status: string }) {
    const vaultId = m.workspace.vaultId;
    return this.prisma.$transaction(async (tx) => {
      await tx.workspaceMember.delete({ where: { id: t.id } });
      if (!t.userId) return { deleted: 0, flagged: 0 };
      const userId = t.userId;
      const granted = await tx.workspaceItemGrant.findMany({
        where: { workspaceId: m.workspace.id, userId },
        select: { itemId: true },
      });
      const itemIds = granted.map((g) => g.itemId);
      await tx.workspaceItemGrant.deleteMany({ where: { workspaceId: m.workspace.id, userId } });
      await tx.workspaceItemFavorite.deleteMany({ where: { userId, item: { vaultId } } });

      const items = await tx.vaultItem.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, workspaceShared: true, grants: { select: { permission: true } } },
      });
      const orphans = items.filter((i) => !i.workspaceShared && i.grants.length === 0);
      const leaderless = items.filter(
        (i) =>
          !i.workspaceShared &&
          i.grants.length > 0 &&
          !i.grants.some((g) => g.permission === "MANAGE"),
      );
      if (orphans.length)
        await tx.vaultItem.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
      if (leaderless.length)
        await tx.workspaceItemGrant.updateMany({
          where: { itemId: { in: leaderless.map((i) => i.id) } },
          data: { permission: "MANAGE" },
        });
      const hadWorkspaceKey = t.status === "CONFIRMED";
      const flagged = await tx.vaultItem.updateMany({
        where: {
          vaultId,
          OR: [
            { id: { in: itemIds.filter((id) => !orphans.some((o) => o.id === id)) } },
            ...(hadWorkspaceKey ? [{ workspaceShared: true }] : []),
          ],
        },
        data: { rekeyNeeded: true },
      });
      if (hadWorkspaceKey)
        await tx.workspace.update({ where: { id: m.workspace.id }, data: { rekeyNeeded: true } });
      return { deleted: orphans.length, flagged: flagged.count };
    });
  }

  /**
   * Rotates the workspace key: the client sealed a fresh key to every
   * confirmed member and re-wrapped every workspace-shared item's key with it.
   * The sets must be complete, so nobody is left on the old key.
   */
  async rekey(auth: AuthContext, workspaceId: string, dto: RekeyWorkspaceDto) {
    const m = await this.access.membership(auth, workspaceId, { admin: true });
    const [members, shared] = await Promise.all([
      this.prisma.workspaceMember.findMany({
        where: { workspaceId, status: "CONFIRMED" },
        select: { id: true, userId: true },
      }),
      this.prisma.vaultItem.findMany({
        where: { vaultId: m.workspace.vaultId, workspaceShared: true },
        select: { id: true },
      }),
    ]);
    const sameSet = (a: string[], b: string[]) =>
      a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));
    if (
      !sameSet(
        dto.members.map((x) => x.userId),
        members.map((x) => x.userId!),
      )
    )
      throw new ConflictException({
        message: "Members changed meanwhile. Reload and try again.",
        code: "REKEY_STALE",
      });
    if (
      !sameSet(
        dto.items.map((x) => x.itemId),
        shared.map((x) => x.id),
      )
    )
      throw new ConflictException({
        message: "Shared credentials changed meanwhile. Reload and try again.",
        code: "REKEY_STALE",
      });
    if (dto.items.some((i) => !isEnvelope(i.workspaceWrappedKey)))
      throw new BadRequestException("Invalid wrapped key");
    await this.prisma.$transaction(async (tx) => {
      for (const s of dto.members)
        await tx.workspaceMember.updateMany({
          where: { workspaceId, userId: s.userId },
          data: { protectedWorkspaceKey: s.protectedWorkspaceKey },
        });
      for (const i of dto.items)
        await tx.vaultItem.update({
          where: { id: i.itemId },
          data: { protectedItemKey: i.workspaceWrappedKey },
        });
      await tx.workspace.update({ where: { id: workspaceId }, data: { rekeyNeeded: false } });
    });
    await this.activity.log(this.access.scoped(auth, m), "workspace.rekeyed", {
      metadata: { count: dto.items.length },
    });
  }

  // ─── Member profile ────────────────────────────────────────────────────────

  /**
   * A member and the credentials they can open, limited to credentials the
   * viewer can open too. Access only: no field values, no keys.
   */
  async profile(auth: AuthContext, workspaceId: string, memberId: string): Promise<MemberProfile> {
    const m = await this.access.membership(auth, workspaceId);
    const t = await this.prisma.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
      include: { user: { select: { name: true, publicKey: true } } },
    });
    if (!t || (t.status === "INVITED" && !isAdmin(m.member.role)))
      throw new NotFoundException("Member not found");
    let credentials: MemberProfile["credentials"] = [];
    let soleAccessCount: number | null = null;
    if (t.userId) {
      const targetId = t.userId;
      const items = await this.prisma.vaultItem.findMany({
        where: {
          vaultId: m.workspace.vaultId,
          deletedAt: null,
          AND: [
            visibleWhere(auth.userId),
            t.status === "CONFIRMED"
              ? visibleWhere(targetId)
              : { grants: { some: { userId: targetId } } },
          ],
        },
        select: {
          id: true,
          name: true,
          type: true,
          host: true,
          username: true,
          workspaceShared: true,
          grants: { select: { userId: true, permission: true } },
        },
        orderBy: { name: "asc" },
        take: 500,
      });
      credentials = items.flatMap((i) => {
        const permission = permissionOf(i, targetId, t.role);
        if (!permission) return [];
        return [
          {
            id: i.id,
            name: i.name,
            type: i.type,
            subtitle: i.username ?? i.host,
            host: i.host,
            permission,
            via: i.grants.some((g) => g.userId === targetId)
              ? ("grant" as const)
              : ("workspace" as const),
          },
        ];
      });
      if (isAdmin(m.member.role)) {
        // Counted over the whole workspace: the admin needs this before removing someone.
        const sole = await this.prisma.vaultItem.findMany({
          where: {
            vaultId: m.workspace.vaultId,
            workspaceShared: false,
            grants: { some: { userId: targetId } },
          },
          select: { _count: { select: { grants: true } } },
        });
        soleAccessCount = sole.filter((s) => s._count.grants === 1).length;
      }
    }
    return { member: toMember(t), credentials, soleAccessCount };
  }

  // ─── Audit ─────────────────────────────────────────────────────────────────

  /** Owners and admins see everything; members see their own actions. */
  async audit(auth: AuthContext, workspaceId: string, q: AuditQuery) {
    const m = await this.access.membership(auth, workspaceId);
    const admin = isAdmin(m.member.role);
    return this.activity.listWorkspace(workspaceId, {
      cursor: q.cursor,
      limit: q.limit ?? 50,
      userId: admin ? q.userId : auth.userId,
    });
  }

  // ─── Folders and tags ──────────────────────────────────────────────────────

  async folders(auth: AuthContext, workspaceId: string) {
    const m = await this.access.membership(auth, workspaceId);
    const rows = await this.prisma.collection.findMany({
      where: { vaultId: m.workspace.vaultId },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: { items: { where: { deletedAt: null, ...visibleWhere(auth.userId) } } },
        },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      description: c.description,
      itemCount: c._count.items,
      noteCount: 0,
    }));
  }

  async createFolder(auth: AuthContext, workspaceId: string, dto: FolderDto) {
    const m = await this.access.membership(auth, workspaceId);
    const name = dto.name.trim();
    if (await this.prisma.collection.findFirst({ where: { vaultId: m.workspace.vaultId, name } }))
      throw new ConflictException("A folder with this name exists");
    const c = await this.prisma.collection.create({
      data: { vaultId: m.workspace.vaultId, name, color: dto.color ?? null },
    });
    await this.activity.log(this.access.scoped(auth, m), "workspace.folder_created", {
      metadata: { to: name },
    });
    return {
      id: c.id,
      name: c.name,
      color: c.color,
      description: null,
      itemCount: 0,
      noteCount: 0,
    };
  }

  /** Items in the folder stay; they just leave it. */
  async deleteFolder(auth: AuthContext, workspaceId: string, folderId: string) {
    const m = await this.access.membership(auth, workspaceId, { admin: true });
    const c = await this.prisma.collection.findFirst({
      where: { id: folderId, vaultId: m.workspace.vaultId },
    });
    if (!c) throw new NotFoundException("Folder not found");
    await this.prisma.collection.delete({ where: { id: c.id } });
    await this.activity.log(this.access.scoped(auth, m), "workspace.folder_deleted", {
      metadata: { from: c.name },
    });
  }

  /** Tags on items the caller can open; tags only on hidden items stay hidden. */
  async tags(auth: AuthContext, workspaceId: string) {
    const m = await this.access.membership(auth, workspaceId);
    const rows = await this.prisma.tag.findMany({
      where: { vaultId: m.workspace.vaultId },
      include: {
        _count: {
          select: {
            items: { where: { item: { deletedAt: null, ...visibleWhere(auth.userId) } } },
          },
        },
      },
      orderBy: { name: "asc" },
    });
    return rows
      .filter((t) => t._count.items > 0)
      .map((t) => ({ id: t.id, name: t.name, itemCount: t._count.items, noteCount: 0 }));
  }
}
