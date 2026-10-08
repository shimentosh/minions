import type { VaultKeys } from "@minions/core";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ArrayMaxSize, IsArray, IsUUID } from "class-validator";
import type { Response } from "express";
import { ActivityService } from "../activity/activity.service";
import { AuthKeyDto } from "../auth/auth.dto";
import { AuthService } from "../auth/auth.service";
import {
  Auth,
  type AuthContext,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import { PrismaService } from "../common/prisma.service";
import { SessionsService } from "../sessions/sessions.service";

class ExistingDto {
  @IsArray() @ArrayMaxSize(5000) @IsUUID(4, { each: true }) itemIds!: string[];
  @IsArray() @ArrayMaxSize(5000) @IsUUID(4, { each: true }) noteIds!: string[];
}

@Injectable()
export class VaultService {
  constructor(
    readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly activity: ActivityService,
  ) {}

  async keys(ctx: AuthContext): Promise<VaultKeys> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    const vault = await this.prisma.vault.findFirstOrThrow({
      where: { id: ctx.vaultId, userId: ctx.userId },
    });
    return {
      userId: user.id,
      vaultId: vault.id,
      kdf: {
        type: "argon2id",
        memory: user.kdfMemory,
        iterations: user.kdfIterations,
        parallelism: user.kdfParallelism,
        salt: user.kdfSalt,
      },
      protectedUserKey: user.protectedUserKey,
      protectedVaultKey: vault.protectedKey,
      pendingProtectedVaultKey: vault.pendingProtectedKey,
      publicKey: user.publicKey,
      protectedPrivateKey: user.protectedPrivateKey,
    };
  }

  async unlock(ctx: AuthContext, authKey: string) {
    try {
      await this.auth.verifyAuthKey(ctx, authKey);
    } catch (e) {
      await this.activity.log(ctx, "vault.unlock_failed");
      throw e;
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { autoLockMinutes: true },
    });
    const until = new Date(Date.now() + Math.max(user.autoLockMinutes, 1) * 60_000);
    await this.prisma.session.update({
      where: { id: ctx.sessionId },
      data: { vaultUnlockedUntil: until },
    });
    await this.activity.log(ctx, "vault.unlocked");
    return { vaultUnlockedUntil: until.toISOString(), keys: await this.keys(ctx) };
  }

  async lock(ctx: AuthContext) {
    await this.prisma.session.update({
      where: { id: ctx.sessionId },
      data: { vaultUnlockedUntil: null },
    });
    await this.activity.log(ctx, "vault.locked");
  }

  /** Revokes every session of the account, this one included. */
  async emergencyLock(ctx: AuthContext) {
    const count = await this.sessions.revokeAll(ctx, true);
    await this.activity.securityEvent(ctx, "emergency_lock", "critical", { count });
    return { revokedSessions: count };
  }

  /**
   * A complete backup that is still encrypted end to end: field values,
   * versions and note bodies stay as envelopes, and the wrapped keys plus KDF
   * parameters are included so the master password alone restores it.
   */
  async exportEncrypted(ctx: AuthContext) {
    const [keys, items, notes, projects, collections, tags, relations] = await Promise.all([
      this.keys(ctx),
      this.prisma.vaultItem.findMany({
        where: { vaultId: ctx.vaultId },
        include: {
          fields: { orderBy: { position: "asc" } },
          versions: true,
          tags: { include: { tag: true } },
          usedBy: true,
        },
      }),
      this.prisma.note.findMany({
        where: { vaultId: ctx.vaultId },
        include: { tags: { include: { tag: true } } },
      }),
      this.prisma.project.findMany({ where: { vaultId: ctx.vaultId } }),
      this.prisma.collection.findMany({ where: { vaultId: ctx.vaultId } }),
      this.prisma.tag.findMany({ where: { vaultId: ctx.vaultId } }),
      this.prisma.vaultItemRelation.findMany({ where: { from: { vaultId: ctx.vaultId } } }),
    ]);
    await this.activity.log(ctx, "vault.exported", {
      metadata: { count: items.length, kind: "encrypted" },
    });
    return {
      format: "minions-encrypted-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      keys,
      projects: projects.map(({ id, name, description, color, archivedAt }) => ({
        id,
        name,
        description,
        color,
        archivedAt,
      })),
      collections: collections.map(({ id, name, description, color }) => ({
        id,
        name,
        description,
        color,
      })),
      tags: tags.map(({ id, name }) => ({ id, name })),
      items: items.map((i) => ({
        id: i.id,
        type: i.type,
        name: i.name,
        description: i.description,
        projectId: i.projectId,
        collectionId: i.collectionId,
        favorite: i.favorite,
        metadata: i.metadata,
        tags: i.tags.map((t) => t.tag.name),
        usedByProjectIds: i.usedBy.map((u) => u.projectId),
        // Items shared with people: their own key, wrapped by the vault key. Fields are under it.
        protectedItemKey: i.protectedItemKey,
        fields: i.fields.map(({ key, label, kind, sensitive, value }) => ({
          key,
          label,
          kind,
          sensitive,
          value,
        })),
        versions: i.versions.map(({ revision, fields, changedKeys, createdAt }) => ({
          revision,
          fields,
          changedKeys,
          createdAt,
        })),
        deletedAt: i.deletedAt,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      })),
      notes: notes.map((n) => ({
        id: n.id,
        title: n.title,
        contentEnc: n.contentEnc,
        projectId: n.projectId,
        collectionId: n.collectionId,
        pinned: n.pinned,
        favorite: n.favorite,
        archivedAt: n.archivedAt,
        deletedAt: n.deletedAt,
        tags: n.tags.map((t) => t.tag.name),
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      })),
      relations: relations.map(({ fromItemId, toItemId, kind }) => ({
        fromItemId,
        toItemId,
        kind,
      })),
    };
  }
}

@Controller("vault")
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  /**
   * The KDF parameters needed to unlock. That is all a locked session gets:
   * the wrapped keys come back from a successful unlock, so a stolen session
   * token alone yields nothing to attack the master password with offline.
   */
  @Get("kdf")
  async kdf(@Auth() auth: AuthContext) {
    const { kdf } = await this.vault.keys(auth);
    return { kdf };
  }

  @UseGuards(VaultUnlockedGuard)
  @Get("keys")
  keys(@Auth() auth: AuthContext) {
    return this.vault.keys(auth);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("unlock")
  @HttpCode(200)
  unlock(@Auth() auth: AuthContext, @Body() dto: AuthKeyDto) {
    return this.vault.unlock(auth, dto.authKey);
  }

  /** Sent while the user is active, to slide the unlock window (the guard does the sliding). */
  @UseGuards(VaultUnlockedGuard)
  @Post("heartbeat")
  @HttpCode(204)
  heartbeat() {}

  @Post("lock")
  @HttpCode(204)
  async lock(@Auth() auth: AuthContext) {
    await this.vault.lock(auth);
  }

  @Post("emergency-lock")
  @HttpCode(200)
  async emergencyLock(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const result = await this.vault.emergencyLock(auth);
    res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    return result;
  }

  /** Which of these ids are already in this vault (restoring a backup skips them). */
  @UseGuards(VaultUnlockedGuard)
  @Post("existing")
  @HttpCode(200)
  async existing(@Auth() auth: AuthContext, @Body() dto: ExistingDto) {
    const [items, notes] = await Promise.all([
      this.vault.prisma.vaultItem.findMany({
        where: { vaultId: auth.vaultId, id: { in: dto.itemIds } },
        select: { id: true },
      }),
      this.vault.prisma.note.findMany({
        where: { vaultId: auth.vaultId, id: { in: dto.noteIds } },
        select: { id: true },
      }),
    ]);
    return { itemIds: items.map((i) => i.id), noteIds: notes.map((n) => n.id) };
  }

  @UseGuards(VaultUnlockedGuard)
  @Get("export")
  exportEncrypted(@Auth() auth: AuthContext) {
    return this.vault.exportEncrypted(auth);
  }
}

@Module({ controllers: [VaultController], providers: [VaultService] })
export class VaultModule {}
