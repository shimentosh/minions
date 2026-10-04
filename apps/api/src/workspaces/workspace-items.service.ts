import {
  type ItemAccessResponse,
  type ItemPermission,
  isEnvelope,
  isSealedKey,
  matchHost,
  normalizeHost,
  type Page,
  registrableDomain,
  type VaultItemSummary,
  type WorkspaceItemDetail,
  type WorkspaceItemSummary,
} from "@minions/core";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { Action } from "../activity/activity.service";
import { ActivityService } from "../activity/activity.service";
import type { AuthContext } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { ListItemsQuery, UpsertItemDto } from "../vault-items/items.dto";
import { ItemsService, toSummary } from "../vault-items/items.service";
import {
  type Membership,
  manageWhere,
  permissionOf,
  visibleWhere,
  WorkspaceAccess,
} from "./access";
import type {
  CreateWorkspaceItemDto,
  ItemAccessDto,
  RekeyItemDto,
  WorkspacePatchItemDto,
} from "./workspaces.dto";

const SUMMARY_INCLUDE = {
  project: { select: { id: true, name: true, color: true } },
  collection: { select: { id: true, name: true, color: true } },
  tags: { select: { tag: { select: { name: true } } } },
} satisfies Prisma.VaultItemInclude;

/**
 * Workspace credentials. Storage, field validation (a sensitive value must be
 * ciphertext), history and search are the personal vault's ItemsService, run
 * against the workspace's vault after WorkspaceAccess has authorised the
 * caller. What is specific to workspaces lives here: per-item keys, grants,
 * per-person favorites, and the access rules.
 */
@Injectable()
export class WorkspaceItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccess,
    private readonly items: ItemsService,
    private readonly activity: ActivityService,
  ) {}

  /** Workspace items never belong to personal projects and carry no reuse fingerprint. */
  private clean(dto: UpsertItemDto): UpsertItemDto {
    return {
      ...dto,
      projectId: null,
      usedByProjectIds: [],
      favorite: false,
      signals: dto.signals ? { ...dto.signals, passwordFingerprint: undefined } : undefined,
    };
  }

  private async decorate(
    auth: AuthContext,
    m: Membership,
    summaries: VaultItemSummary[],
  ): Promise<WorkspaceItemSummary[]> {
    if (!summaries.length) return [];
    const ids = summaries.map((s) => s.id);
    const rows = await this.prisma.vaultItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        workspaceShared: true,
        rekeyNeeded: true,
        grants: { select: { userId: true, permission: true } },
        favoritedBy: { where: { userId: auth.userId }, select: { userId: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return summaries.flatMap((s) => {
      const r = byId.get(s.id);
      const permission = r ? permissionOf(r, auth.userId, m.member.role) : null;
      if (!r || !permission) return [];
      return [
        {
          ...s,
          favorite: r.favoritedBy.length > 0,
          workspaceId: m.workspace.id,
          permission,
          workspaceShared: r.workspaceShared,
          grantCount: r.grants.length,
          createdBy: r.createdBy,
          rekeyNeeded: r.rekeyNeeded,
        },
      ];
    });
  }

  async list(
    auth: AuthContext,
    workspaceId: string,
    q: ListItemsQuery,
  ): Promise<Page<WorkspaceItemSummary>> {
    const m = await this.access.membership(auth, workspaceId);
    const scope: Prisma.VaultItemWhereInput = {
      AND: [
        q.trash === "true" ? manageWhere(auth.userId, m.member.role) : visibleWhere(auth.userId),
        ...(q.favorite === "true" ? [{ favoritedBy: { some: { userId: auth.userId } } }] : []),
      ],
    };
    const page = await this.items.list(
      this.access.scoped(auth, m),
      { ...q, favorite: undefined, projectId: undefined },
      scope,
    );
    return { ...page, items: await this.decorate(auth, m, page.items) };
  }

  async get(auth: AuthContext, workspaceId: string, id: string): Promise<WorkspaceItemDetail> {
    const m = await this.access.membership(auth, workspaceId);
    const { item, permission } = await this.access.item(auth, m, id);
    const grant = item.grants.find((g) => g.userId === auth.userId);
    const key = grant
      ? { source: "grant" as const, wrapped: grant.protectedItemKey }
      : { source: "workspace" as const, wrapped: item.protectedItemKey! };
    const detail = await this.items.get(this.access.scoped(auth, m), id);
    const [summary] = await this.decorate(auth, m, [detail]);
    return {
      ...detail,
      ...summary!,
      permission,
      // Relations and "used by" belong to personal vaults.
      relations: [],
      usedBy: [],
      // History holds old secrets: for the people who could change them anyway.
      versionCount: permission === "MANAGE" ? detail.versionCount : 0,
      key,
    };
  }

  /**
   * Checks a requested access state and returns who is added, removed and changed.
   * `requireAllKeys`: a re-key, where every grant carries the new key.
   */
  private async planAccess(
    m: Membership,
    access: ItemAccessDto,
    current: { workspaceShared: boolean; grants: { userId: string; permission: ItemPermission }[] },
    opts: { requireAllKeys?: boolean } = {},
  ) {
    const ids = access.grants.map((g) => g.userId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException("Duplicate member");
    const members = await this.access.assertConfirmedMembers(m.workspace.id, ids);
    const before = new Map(current.grants.map((g) => [g.userId, g]));
    for (const g of access.grants) {
      const needsKey = opts.requireAllKeys || !before.has(g.userId);
      if (needsKey && !isSealedKey(g.protectedItemKey))
        throw new BadRequestException({
          message: "A new grant needs the item key sealed to that member",
          code: "KEY_REQUIRED",
        });
    }
    if (access.workspaceShared) {
      const needsKey = opts.requireAllKeys || !current.workspaceShared;
      if (needsKey && !isEnvelope(access.workspaceWrappedKey))
        throw new BadRequestException({
          message: "Sharing with the workspace needs the item key wrapped by the workspace key",
          code: "KEY_REQUIRED",
        });
      if (access.workspaceWrappedKey && !isEnvelope(access.workspaceWrappedKey))
        throw new BadRequestException("Invalid wrapped key");
    }
    if (!access.workspaceShared && !access.grants.some((g) => g.permission === "MANAGE"))
      throw new BadRequestException({
        message: "Someone must be able to manage this credential",
        code: "NO_MANAGER",
      });
    const after = new Set(ids);
    return {
      members,
      added: access.grants.filter((g) => !before.has(g.userId)),
      removed: current.grants.filter((g) => !after.has(g.userId)),
      changed: access.grants.filter(
        (g) => before.has(g.userId) && before.get(g.userId)!.permission !== g.permission,
      ),
    };
  }

  private async writeAccess(
    tx: Prisma.TransactionClient,
    auth: AuthContext,
    m: Membership,
    itemId: string,
    access: ItemAccessDto,
    plan: Awaited<ReturnType<WorkspaceItemsService["planAccess"]>>,
    opts: { replaceKeys?: boolean; wasShared: boolean },
  ) {
    const keep = access.grants.map((g) => g.userId);
    await tx.workspaceItemGrant.deleteMany({ where: { itemId, userId: { notIn: keep } } });
    for (const g of access.grants) {
      const isNew = plan.added.some((a) => a.userId === g.userId);
      if (isNew) {
        await tx.workspaceItemGrant.create({
          data: {
            itemId,
            userId: g.userId,
            workspaceId: m.workspace.id,
            permission: g.permission,
            protectedItemKey: g.protectedItemKey!,
            grantedById: auth.userId,
          },
        });
      } else {
        await tx.workspaceItemGrant.update({
          where: { itemId_userId: { itemId, userId: g.userId } },
          data: {
            permission: g.permission,
            ...(opts.replaceKeys ? { protectedItemKey: g.protectedItemKey! } : {}),
          },
        });
      }
    }
    // Anyone who held this item's key and loses access may have kept it.
    const lostAccess = plan.removed.length > 0 || (opts.wasShared && !access.workspaceShared);
    await tx.vaultItem.update({
      where: { id: itemId },
      data: {
        workspaceShared: access.workspaceShared,
        protectedItemKey: access.workspaceShared ? (access.workspaceWrappedKey ?? undefined) : null,
        ...(opts.replaceKeys ? { rekeyNeeded: false } : lostAccess ? { rekeyNeeded: true } : {}),
      },
    });
  }

  private async logAccess(
    scoped: AuthContext,
    item: { id: string; name: string; type: string },
    plan: Awaited<ReturnType<WorkspaceItemsService["planAccess"]>>,
    shared: { before: boolean; after: boolean },
  ) {
    const email = (id: string) => plan.members.get(id)?.email;
    for (const g of plan.added)
      if (g.userId !== scoped.userId)
        await this.activity.log(scoped, "item.shared", {
          item,
          metadata: { member: email(g.userId), permission: g.permission },
        });
    if (plan.removed.length) {
      // They may have left the workspace already, so their email comes from the account.
      const users = await this.prisma.user.findMany({
        where: { id: { in: plan.removed.map((g) => g.userId) } },
        select: { email: true },
      });
      for (const u of users)
        await this.activity.log(scoped, "item.access_removed", {
          item,
          metadata: { member: u.email },
        });
    }
    for (const g of plan.changed)
      await this.activity.log(scoped, "item.access_changed", {
        item,
        metadata: { member: email(g.userId), permission: g.permission },
      });
    if (shared.before !== shared.after)
      await this.activity.log(scoped, "item.access_changed", {
        item,
        metadata: { workspaceShared: shared.after },
      });
  }

  async create(
    auth: AuthContext,
    workspaceId: string,
    dto: CreateWorkspaceItemDto,
  ): Promise<WorkspaceItemSummary> {
    const m = await this.access.membership(auth, workspaceId);
    const self = dto.access.grants.find((g) => g.userId === auth.userId);
    // The creator always keeps a key, so they can open what they just saved.
    if (self?.permission !== "MANAGE")
      throw new BadRequestException({
        message: "The creator must keep manage access",
        code: "CREATOR_GRANT_REQUIRED",
      });
    const plan = await this.planAccess(m, dto.access, { workspaceShared: false, grants: [] });
    const scoped = this.access.scoped(auth, m);
    const item = this.clean(dto.item);
    await this.prisma.$transaction(async (tx) => {
      await this.items.create(scoped, item, { tx, log: false });
      await tx.vaultItem.update({ where: { id: item.id }, data: { createdById: auth.userId } });
      await this.writeAccess(tx, auth, m, item.id, dto.access, plan, { wasShared: false });
      if (dto.item.favorite)
        await tx.workspaceItemFavorite.create({ data: { itemId: item.id, userId: auth.userId } });
    });
    const ref = { id: item.id, name: item.name, type: item.type };
    await this.activity.log(scoped, "item.created", { item: ref });
    await this.logAccess(scoped, ref, plan, { before: false, after: dto.access.workspaceShared });
    return this.summary(auth, m, item.id);
  }

  private async summary(auth: AuthContext, m: Membership, id: string) {
    const row = await this.prisma.vaultItem.findUniqueOrThrow({
      where: { id },
      include: SUMMARY_INCLUDE,
    });
    const [s] = await this.decorate(auth, m, [toSummary(row)]);
    return s!;
  }

  async update(auth: AuthContext, workspaceId: string, id: string, dto: UpsertItemDto) {
    const m = await this.access.membership(auth, workspaceId);
    await this.access.item(auth, m, id, "MANAGE");
    await this.items.update(this.access.scoped(auth, m), id, this.clean(dto));
    if (dto.favorite !== undefined) await this.setFavorite(auth.userId, id, dto.favorite);
    return this.summary(auth, m, id);
  }

  private async setFavorite(userId: string, itemId: string, favorite: boolean) {
    if (favorite)
      await this.prisma.workspaceItemFavorite.upsert({
        where: { itemId_userId: { itemId, userId } },
        create: { itemId, userId },
        update: {},
      });
    else await this.prisma.workspaceItemFavorite.deleteMany({ where: { itemId, userId } });
  }

  /** Favorites are personal and need view access; renaming and filing need manage. */
  async patch(auth: AuthContext, workspaceId: string, id: string, dto: WorkspacePatchItemDto) {
    const m = await this.access.membership(auth, workspaceId);
    const organises = dto.name !== undefined || dto.collectionId !== undefined || !!dto.tags;
    await this.access.item(auth, m, id, organises ? "MANAGE" : "VIEW");
    if (dto.favorite !== undefined) await this.setFavorite(auth.userId, id, dto.favorite);
    if (organises)
      await this.items.patch(this.access.scoped(auth, m), id, {
        name: dto.name,
        collectionId: dto.collectionId,
        tags: dto.tags,
      });
    return this.summary(auth, m, id);
  }

  async remove(auth: AuthContext, workspaceId: string, id: string) {
    const m = await this.access.membership(auth, workspaceId);
    await this.access.item(auth, m, id, "MANAGE");
    await this.items.remove(this.access.scoped(auth, m), id);
  }

  async restore(auth: AuthContext, workspaceId: string, id: string) {
    const m = await this.access.membership(auth, workspaceId);
    await this.access.item(auth, m, id, "MANAGE");
    await this.items.restore(this.access.scoped(auth, m), id);
  }

  async purge(auth: AuthContext, workspaceId: string, id: string) {
    const m = await this.access.membership(auth, workspaceId);
    await this.access.item(auth, m, id, "MANAGE");
    await this.items.purge(this.access.scoped(auth, m), id);
  }

  async versions(auth: AuthContext, workspaceId: string, id: string) {
    const m = await this.access.membership(auth, workspaceId);
    await this.access.item(auth, m, id, "MANAGE");
    return this.items.versions(this.access.scoped(auth, m), id);
  }

  async usage(auth: AuthContext, workspaceId: string, id: string, action: Action, field?: string) {
    const m = await this.access.membership(auth, workspaceId);
    await this.access.item(auth, m, id, "VIEW");
    await this.items.recordUsage(this.access.scoped(auth, m), id, action, field);
  }

  async getAccess(auth: AuthContext, workspaceId: string, id: string): Promise<ItemAccessResponse> {
    const m = await this.access.membership(auth, workspaceId);
    const { item, permission } = await this.access.item(auth, m, id);
    const grants = await this.prisma.workspaceItemGrant.findMany({
      where: { itemId: item.id },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
    return {
      workspaceShared: item.workspaceShared,
      permission,
      grants: grants.map((g) => ({
        userId: g.userId,
        name: g.user.name,
        email: g.user.email,
        permission: g.permission,
        createdAt: g.createdAt.toISOString(),
      })),
    };
  }

  /** Sets who can open the item. New grants carry the item key sealed to that member. */
  async setAccess(auth: AuthContext, workspaceId: string, id: string, dto: ItemAccessDto) {
    const m = await this.access.membership(auth, workspaceId);
    const { item } = await this.access.item(auth, m, id, "MANAGE");
    const plan = await this.planAccess(m, dto, item);
    await this.prisma.$transaction((tx) =>
      this.writeAccess(tx, auth, m, id, dto, plan, { wasShared: item.workspaceShared }),
    );
    await this.logAccess(this.access.scoped(auth, m), item, plan, {
      before: item.workspaceShared,
      after: dto.workspaceShared,
    });
    return this.getAccess(auth, workspaceId, id);
  }

  /**
   * Replaces the item key: every field re-encrypted and every grant re-sealed
   * by the client, applied in one transaction. Old versions were encrypted
   * with the old key and are dropped.
   */
  async rekey(auth: AuthContext, workspaceId: string, id: string, dto: RekeyItemDto) {
    const m = await this.access.membership(auth, workspaceId);
    const { item } = await this.access.item(auth, m, id, "MANAGE");
    if (dto.item.id !== id) throw new BadRequestException("Id mismatch");
    const plan = await this.planAccess(m, dto.access, item, { requireAllKeys: true });
    const scoped = this.access.scoped(auth, m);
    await this.prisma.$transaction(async (tx) => {
      await this.items.update(scoped, id, this.clean(dto.item), { tx });
      await tx.vaultItemVersion.deleteMany({ where: { itemId: id } });
      await this.writeAccess(tx, auth, m, id, dto.access, plan, {
        replaceKeys: true,
        wasShared: item.workspaceShared,
      });
    });
    await this.activity.log(scoped, "item.rekeyed", { item });
    await this.logAccess(scoped, item, plan, {
      before: item.workspaceShared,
      after: dto.access.workspaceShared,
    });
    return this.summary(auth, m, id);
  }

  /** Who did what with this item. Its managers only. */
  async itemActivity(auth: AuthContext, workspaceId: string, id: string) {
    const m = await this.access.membership(auth, workspaceId);
    await this.access.item(auth, m, id, "MANAGE");
    return this.activity.listWorkspace(workspaceId, { itemId: id, limit: 30 });
  }

  // ─── Extension ─────────────────────────────────────────────────────────────

  private async confirmedWorkspaces(auth: AuthContext) {
    const rows = await this.prisma.workspaceMember.findMany({
      where: { userId: auth.userId, status: "CONFIRMED" },
      select: {
        role: true,
        workspace: { select: { id: true, name: true, vaultId: true, rekeyNeeded: true } },
      },
    });
    return rows;
  }

  private async decorateAcross(
    auth: AuthContext,
    memberships: Awaited<ReturnType<WorkspaceItemsService["confirmedWorkspaces"]>>,
    rows: Prisma.VaultItemGetPayload<{ include: typeof SUMMARY_INCLUDE }>[],
  ) {
    const byVault = new Map(memberships.map((x) => [x.workspace.vaultId, x]));
    const out: (WorkspaceItemSummary & { workspaceName: string })[] = [];
    for (const r of rows) {
      const ms = byVault.get(r.vaultId);
      if (!ms) continue;
      const m: Membership = {
        workspace: ms.workspace,
        member: { id: "", role: ms.role, status: "CONFIRMED", protectedWorkspaceKey: null },
      };
      const [s] = await this.decorate(auth, m, [toSummary(r)]);
      if (s) out.push({ ...s, workspaceName: ms.workspace.name });
    }
    return out;
  }

  /**
   * Workspace logins for the site the extension is on, across every workspace
   * the caller is confirmed in. Same public-suffix-aware rule as the personal
   * vault: on example.com, never example-login.com or another *.co.uk site.
   */
  async match(auth: AuthContext, host: string) {
    const clean = normalizeHost(host);
    if (!clean) return [];
    const memberships = await this.confirmedWorkspaces(auth);
    if (!memberships.length) return [];
    const domain = registrableDomain(clean);
    const sameSite: Prisma.VaultItemWhereInput[] = domain
      ? [{ host: clean }, { host: domain }, { host: { endsWith: `.${domain}` } }]
      : [{ host: clean }];
    const rows = await this.prisma.vaultItem.findMany({
      where: {
        vaultId: { in: memberships.map((x) => x.workspace.vaultId) },
        deletedAt: null,
        AND: [{ OR: sameSite }, visibleWhere(auth.userId)],
      },
      include: SUMMARY_INCLUDE,
      orderBy: [{ lastAccessedAt: { sort: "desc", nulls: "last" } }],
      take: 20,
    });
    const matched = rows.filter((r) => matchHost(r.host, clean) !== null);
    return (await this.decorateAcross(auth, memberships, matched)).sort(
      (a, b) => Number(b.host === clean) - Number(a.host === clean),
    );
  }

  /** Metadata search across the caller's workspaces, for the extension's search box. */
  async search(auth: AuthContext, q: string) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!terms.length) return [];
    const memberships = await this.confirmedWorkspaces(auth);
    if (!memberships.length) return [];
    const rows = await this.prisma.vaultItem.findMany({
      where: {
        vaultId: { in: memberships.map((x) => x.workspace.vaultId) },
        deletedAt: null,
        AND: [
          visibleWhere(auth.userId),
          ...terms.map((t) => ({ searchText: { contains: t, mode: "insensitive" as const } })),
        ],
      },
      include: SUMMARY_INCLUDE,
      orderBy: [{ updatedAt: "desc" }],
      take: 10,
    });
    return this.decorateAcross(auth, memberships, rows);
  }
}
