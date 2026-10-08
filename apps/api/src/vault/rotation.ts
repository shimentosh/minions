import { isEnvelope } from "@minions/core";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBase64,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { ActivityService } from "../activity/activity.service";
import { AuthService } from "../auth/auth.service";
import { Auth, type AuthContext } from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import { PrismaService } from "../common/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { FindingsStore } from "../security/findings-store";

/**
 * Vault-key rotation. The client generates a new vault key, re-encrypts every
 * secret in the personal vault under it, and the server swaps the wrapped key
 * once nothing is left under the old one. The server never sees either key.
 *
 * Each item and note records the key generation it is encrypted under, so a
 * rotation interrupted by a closed tab resumes where it stopped: the next
 * unlock returns the pending wrapped key and the client carries on. While a
 * rotation is pending, every other session is locked and vault writes other
 * than the rotation itself are refused (VaultUnlockedGuard).
 */

const ENVELOPE = /^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]+={0,2}$/;
const BATCH_MAX = 100;

class StartRotationDto {
  @IsBase64() @Length(44, 44) authKey!: string;
  /** The new vault key, wrapped by the user key with AAD `vault:<id>:key`. */
  @Matches(ENVELOPE) @MaxLength(200) protectedVaultKey!: string;
}

class BatchQuery {
  @IsIn(["items", "notes"]) kind!: "items" | "notes";
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(BATCH_MAX) limit?: number;
}

class FieldValueDto {
  @IsString() @Length(1, 120) key!: string;
  @IsString() @MaxLength(65536) value!: string;
}

class VersionDto {
  @IsUUID() id!: string;
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => FieldValueDto)
  fields!: FieldValueDto[];
}

class RotatedItemDto {
  @IsUUID(4) id!: string;
  /** Every sensitive field, re-encrypted. Plaintext fields are not sent. */
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => FieldValueDto)
  fields!: FieldValueDto[];
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => VersionDto)
  versions!: VersionDto[];
  @IsOptional() @Matches(/^[0-9a-f]{64}$/) passwordFingerprint?: string;
  /**
   * Items shared with people have their own key: only that key is re-wrapped
   * under the new vault key, and fields and versions are sent empty.
   */
  @IsOptional() @Matches(ENVELOPE) @MaxLength(200) protectedItemKey?: string;
}

class NoteVersionDto {
  @IsUUID() id!: string;
  @IsOptional() @IsString() @MaxLength(2_000_000) contentEnc?: string | null;
}

class RotatedNoteDto {
  @IsUUID(4) id!: string;
  @IsOptional() @IsString() @MaxLength(2_000_000) contentEnc?: string | null;
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => NoteVersionDto)
  versions!: NoteVersionDto[];
}

class SubmitBatchDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BATCH_MAX)
  @ValidateNested({ each: true })
  @Type(() => RotatedItemDto)
  items?: RotatedItemDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BATCH_MAX)
  @ValidateNested({ each: true })
  @Type(() => RotatedNoteDto)
  notes?: RotatedNoteDto[];
}

type VersionField = { key: string; value: string; sensitive: boolean };

@Injectable()
export class RotationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly activity: ActivityService,
    private readonly findings: FindingsStore,
  ) {}

  /** The session's own personal vault. Workspace vaults have their own keys and are never rotated here. */
  private async vault(ctx: AuthContext) {
    const vault = await this.prisma.vault.findFirst({
      where: { id: ctx.vaultId, userId: ctx.userId },
    });
    if (!vault) throw new BadRequestException("No personal vault");
    return vault;
  }

  private async remaining(vaultId: string, target: number) {
    const [items, notes] = await Promise.all([
      this.prisma.vaultItem.count({ where: { vaultId, keyGen: { lt: target } } }),
      this.prisma.note.count({ where: { vaultId, keyGen: { lt: target } } }),
    ]);
    return { items, notes };
  }

  async status(ctx: AuthContext) {
    const vault = await this.vault(ctx);
    const pending = vault.pendingProtectedKey !== null;
    return {
      inProgress: pending,
      keyGen: vault.keyGen,
      pendingProtectedVaultKey: vault.pendingProtectedKey,
      remaining: pending
        ? await this.remaining(vault.id, vault.keyGen + 1)
        : { items: 0, notes: 0 },
    };
  }

  async start(ctx: AuthContext, dto: StartRotationDto) {
    // Re-proving the master password: a stolen unlocked session cannot start one.
    await this.auth.verifyAuthKey(ctx, dto.authKey);
    const vault = await this.vault(ctx);
    const started = await this.prisma.vault.updateMany({
      where: { id: vault.id, pendingProtectedKey: null },
      data: { pendingProtectedKey: dto.protectedVaultKey },
    });
    if (started.count !== 1)
      throw new ConflictException({
        message: "A key change is already in progress. Unlock again to finish it.",
        code: "ROTATION_IN_PROGRESS",
      });
    // Other sessions hold the old key in memory: lock them until the swap is done.
    await this.lockOtherSessions(ctx);
    await this.activity.securityEvent(ctx, "vault_key_rotation_started", "warning");
    return this.status(ctx);
  }

  private async lockOtherSessions(ctx: AuthContext) {
    await this.prisma.session.updateMany({
      where: { userId: ctx.userId, id: { not: ctx.sessionId }, vaultUnlockedUntil: { not: null } },
      data: { vaultUnlockedUntil: null },
    });
  }

  private async requirePending(ctx: AuthContext) {
    const vault = await this.vault(ctx);
    if (vault.pendingProtectedKey === null)
      throw new ConflictException({ message: "No key change in progress", code: "NO_ROTATION" });
    return vault;
  }

  /** The next rows still under the old key, ciphertext only. */
  async batch(ctx: AuthContext, q: BatchQuery) {
    const vault = await this.requirePending(ctx);
    const take = q.limit ?? 50;
    const where = { vaultId: vault.id, keyGen: { lt: vault.keyGen + 1 } };
    if (q.kind === "items") {
      const rows = await this.prisma.vaultItem.findMany({
        where,
        orderBy: { id: "asc" },
        take,
        select: {
          id: true,
          type: true,
          passwordFingerprint: true,
          protectedItemKey: true,
          fields: { where: { sensitive: true }, select: { key: true, value: true } },
          versions: { select: { id: true, fields: true } },
        },
      });
      return {
        items: rows.map((r) => ({
          id: r.id,
          type: r.type,
          hasPasswordFingerprint: r.passwordFingerprint !== null,
          protectedItemKey: r.protectedItemKey,
          fields: r.fields,
          versions: (r.protectedItemKey ? [] : r.versions).map((v) => ({
            id: v.id,
            fields: (v.fields as unknown as VersionField[])
              .filter((f) => f.sensitive)
              .map(({ key, value }) => ({ key, value })),
          })),
        })),
      };
    }
    const rows = await this.prisma.note.findMany({
      where,
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        contentEnc: true,
        versions: { select: { id: true, contentEnc: true } },
      },
    });
    return { notes: rows };
  }

  /**
   * Stores re-encrypted rows. Each item must come back with exactly the
   * sensitive fields it has (and each version likewise), every value an
   * envelope, so a buggy client cannot drop a secret or store plaintext.
   * Rows already moved to the new generation are skipped, which makes a
   * retried or duplicated batch harmless.
   */
  async submit(ctx: AuthContext, dto: SubmitBatchDto) {
    const vault = await this.requirePending(ctx);
    const target = vault.keyGen + 1;
    let done = 0;
    let skipped = 0;

    for (const item of dto.items ?? []) {
      const row = await this.prisma.vaultItem.findFirst({
        where: { id: item.id, vaultId: vault.id },
        select: {
          keyGen: true,
          passwordFingerprint: true,
          protectedItemKey: true,
          fields: { where: { sensitive: true }, select: { key: true } },
          versions: { select: { id: true, fields: true } },
        },
      });
      if (!row) throw new BadRequestException("Unknown item");
      if (row.keyGen >= target) {
        skipped++;
        continue;
      }
      if (row.protectedItemKey) {
        // Its fields stay under the item key; only the wrapped key moves.
        if (!item.protectedItemKey || item.fields.length || item.versions.length)
          throw new BadRequestException("A shared item's key must be re-wrapped, nothing else");
        const r = await this.prisma.vaultItem.updateMany({
          where: { id: item.id, vaultId: vault.id, keyGen: { lt: target } },
          data: {
            keyGen: target,
            protectedItemKey: item.protectedItemKey,
            passwordFingerprint:
              row.passwordFingerprint !== null ? (item.passwordFingerprint ?? null) : null,
          },
        });
        if (r.count === 1) done++;
        else skipped++;
        continue;
      }
      assertSameSecrets(
        row.fields.map((f) => f.key),
        item.fields,
      );
      const sentVersions = new Map(item.versions.map((v) => [v.id, v.fields]));
      if (sentVersions.size !== row.versions.length)
        throw new BadRequestException("Every version must be re-encrypted");
      const versionUpdates = row.versions.map((v) => {
        const fields = v.fields as unknown as VersionField[];
        const sent = sentVersions.get(v.id);
        if (!sent) throw new BadRequestException("Every version must be re-encrypted");
        assertSameSecrets(
          fields.filter((f) => f.sensitive).map((f) => f.key),
          sent,
        );
        const byKey = new Map(sent.map((f) => [f.key, f.value]));
        return {
          id: v.id,
          fields: fields.map((f) =>
            f.sensitive ? { ...f, value: byKey.get(f.key)! } : f,
          ) as unknown as Prisma.InputJsonValue,
        };
      });

      const moved = await this.prisma.$transaction(async (tx) => {
        // Conditional on the old generation: a concurrent duplicate does nothing.
        const r = await tx.vaultItem.updateMany({
          where: { id: item.id, vaultId: vault.id, keyGen: { lt: target } },
          data: {
            keyGen: target,
            // The old fingerprint is meaningless under the new key: replace or drop it.
            passwordFingerprint:
              row.passwordFingerprint !== null ? (item.passwordFingerprint ?? null) : null,
          },
        });
        if (r.count !== 1) return false;
        for (const f of item.fields)
          await tx.vaultItemField.updateMany({
            where: { itemId: item.id, key: f.key, sensitive: true },
            data: { value: f.value },
          });
        for (const v of versionUpdates)
          await tx.vaultItemVersion.update({ where: { id: v.id }, data: { fields: v.fields } });
        return true;
      });
      if (moved) done++;
      else skipped++;
    }

    for (const note of dto.notes ?? []) {
      const row = await this.prisma.note.findFirst({
        where: { id: note.id, vaultId: vault.id },
        select: {
          keyGen: true,
          contentEnc: true,
          versions: { select: { id: true, contentEnc: true } },
        },
      });
      if (!row) throw new BadRequestException("Unknown note");
      if (row.keyGen >= target) {
        skipped++;
        continue;
      }
      assertSameBody(row.contentEnc, note.contentEnc);
      const sent = new Map(note.versions.map((v) => [v.id, v.contentEnc ?? null]));
      if (sent.size !== row.versions.length)
        throw new BadRequestException("Every version must be re-encrypted");
      for (const v of row.versions) {
        if (!sent.has(v.id)) throw new BadRequestException("Every version must be re-encrypted");
        assertSameBody(v.contentEnc, sent.get(v.id));
      }
      const moved = await this.prisma.$transaction(async (tx) => {
        const r = await tx.note.updateMany({
          where: { id: note.id, vaultId: vault.id, keyGen: { lt: target } },
          data: { keyGen: target, contentEnc: note.contentEnc ?? null },
        });
        if (r.count !== 1) return false;
        for (const [id, contentEnc] of sent)
          await tx.noteVersion.update({ where: { id }, data: { contentEnc } });
        return true;
      });
      if (moved) done++;
      else skipped++;
    }
    return { done, skipped, remaining: await this.remaining(vault.id, target) };
  }

  /** Swaps in the new key once every row has moved. */
  async finish(ctx: AuthContext) {
    const vault = await this.requirePending(ctx);
    const left = await this.remaining(vault.id, vault.keyGen + 1);
    if (left.items || left.notes)
      throw new ConflictException({
        message: "Some items are still under the old key",
        code: "ROTATION_INCOMPLETE",
      });
    const swapped = await this.prisma.vault.updateMany({
      where: { id: vault.id, keyGen: vault.keyGen, pendingProtectedKey: vault.pendingProtectedKey },
      data: {
        protectedKey: vault.pendingProtectedKey!,
        pendingProtectedKey: null,
        keyGen: { increment: 1 },
      },
    });
    if (swapped.count !== 1) throw new ConflictException("The key change already finished");
    await this.lockOtherSessions(ctx);
    // Reuse findings depend on fingerprints, which changed with the key.
    await this.findings.markDirty(vault.id);
    await this.activity.securityEvent(ctx, "vault_key_rotated", "critical", {
      count: vault.keyGen + 1,
    });
    return { keyGen: vault.keyGen + 1 };
  }
}

export function assertSameSecrets(expected: string[], sent: { key: string; value: string }[]) {
  const keys = new Set(sent.map((f) => f.key));
  if (
    keys.size !== sent.length ||
    keys.size !== expected.length ||
    expected.some((k) => !keys.has(k))
  )
    throw new BadRequestException("Every secret field must be re-encrypted, and nothing else");
  if (sent.some((f) => !isEnvelope(f.value)))
    throw new BadRequestException({
      message: "Sensitive fields must be encrypted on the client",
      code: "PLAINTEXT_SECRET",
    });
}

function assertSameBody(before: string | null, after: string | null | undefined) {
  if ((before === null) !== (after === null || after === undefined))
    throw new BadRequestException("Note bodies must be re-encrypted, not added or removed");
  if (after && !isEnvelope(after))
    throw new BadRequestException({
      message: "Note bodies must be encrypted on the client",
      code: "PLAINTEXT_SECRET",
    });
}

@UseGuards(VaultUnlockedGuard)
@Controller("vault/rotation")
export class RotationController {
  constructor(private readonly rotation: RotationService) {}

  @Get()
  status(@Auth() auth: AuthContext) {
    return this.rotation.status(auth);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("start")
  @HttpCode(200)
  start(@Auth() auth: AuthContext, @Body() dto: StartRotationDto) {
    return this.rotation.start(auth, dto);
  }

  @Get("batch")
  batch(@Auth() auth: AuthContext, @Query() q: BatchQuery) {
    return this.rotation.batch(auth, q);
  }

  @Post("batch")
  @HttpCode(200)
  submit(@Auth() auth: AuthContext, @Body() dto: SubmitBatchDto) {
    return this.rotation.submit(auth, dto);
  }

  @Post("finish")
  @HttpCode(200)
  finish(@Auth() auth: AuthContext) {
    return this.rotation.finish(auth);
  }
}
