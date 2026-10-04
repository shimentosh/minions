import { isEnvelope, type ShareMeta, type ShareSummary } from "@minions/core";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  IsBase64,
  IsBoolean,
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
  ValidateIf,
} from "class-validator";
import { ActivityService } from "../activity/activity.service";
import { Auth, type AuthContext, Client, type ClientInfo, Public } from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import { PrismaService } from "../common/prisma.service";
import { safeEqual, sha256 } from "../common/server-crypto";

const EXPIRY_CHOICES = [15, 60, 1440, 10080, 43200]; // 15 min, 1 h, 1 day, 7 days, 30 days
const MAX_WRONG_PASSPHRASE = 10;

class CreateShareDto {
  @IsUUID(4) id!: string;
  @IsOptional() @IsUUID(4) itemId?: string | null;
  @IsString() @Length(1, 120) label!: string;
  @IsString() @MaxLength(200_000) ciphertext!: string;
  @IsIn(EXPIRY_CHOICES) expiresInMinutes!: number;
  @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(100) maxViews!: number | null;
  @IsBoolean() includesTotp!: boolean;
  @IsOptional() @IsBase64() @Length(24, 24) passphraseSalt?: string;
  @IsOptional() @Matches(/^[0-9a-f]{64}$/) accessHash?: string;
}

class OpenShareDto {
  @IsOptional() @Matches(/^[0-9a-f]{64}$/) accessToken?: string;
}

type Row = Awaited<ReturnType<PrismaService["share"]["findUniqueOrThrow"]>>;

function status(s: Row): ShareSummary["status"] {
  if (s.revokedAt) return "revoked";
  if (s.maxViews !== null && s.viewCount >= s.maxViews) return "used";
  if (s.expiresAt <= new Date()) return "expired";
  return "active";
}

@Injectable()
export class SharesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Shares");
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /** Expired links lose their ciphertext, not just their visibility. */
  onModuleInit() {
    this.timer = setInterval(() => void this.purge().catch(() => undefined), 10 * 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async purge() {
    const r = await this.prisma.share.updateMany({
      where: { ciphertext: { not: null }, expiresAt: { lte: new Date() } },
      data: { ciphertext: null, burnedAt: new Date() },
    });
    if (r.count) this.logger.log(`purged ${r.count} expired share(s)`);
  }

  async create(auth: AuthContext, dto: CreateShareDto) {
    if (!isEnvelope(dto.ciphertext))
      throw new BadRequestException("Share content must be encrypted on the client");
    if (!!dto.passphraseSalt !== !!dto.accessHash)
      throw new BadRequestException("Passphrase settings are incomplete");
    let item: { id: string; name: string; type: string } | null = null;
    if (dto.itemId) {
      item = await this.prisma.vaultItem.findFirst({
        where: { id: dto.itemId, vaultId: auth.vaultId },
        select: { id: true, name: true, type: true },
      });
      if (!item) throw new NotFoundException();
    }
    if (await this.prisma.share.findUnique({ where: { id: dto.id }, select: { id: true } }))
      throw new ConflictException("Share id already exists");
    const share = await this.prisma.share.create({
      data: {
        id: dto.id,
        userId: auth.userId,
        vaultId: auth.vaultId,
        itemId: item?.id ?? null,
        label: dto.label.trim(),
        ciphertext: dto.ciphertext,
        expiresAt: new Date(Date.now() + dto.expiresInMinutes * 60_000),
        maxViews: dto.maxViews,
        includesTotp: dto.includesTotp,
        passphraseSalt: dto.passphraseSalt ?? null,
        // Already SHA-256 of the token; the token itself never reaches the server until it is used.
        accessHash: dto.accessHash ?? null,
      },
    });
    await this.activity.log(auth, "share.created", {
      item: item ?? { id: share.id, name: share.label, type: "SHARE" },
      metadata: { count: dto.maxViews ?? 0, kind: dto.includesTotp ? "with 2fa" : "secret" },
    });
    return this.summary(share);
  }

  summary(s: Row): ShareSummary {
    return {
      id: s.id,
      itemId: s.itemId,
      label: s.label,
      expiresAt: s.expiresAt.toISOString(),
      maxViews: s.maxViews,
      viewCount: s.viewCount,
      includesTotp: s.includesTotp,
      requiresPassphrase: !!s.accessHash,
      status: status(s),
      createdAt: s.createdAt.toISOString(),
      lastViewedAt: s.lastViewedAt?.toISOString() ?? null,
    };
  }

  async list(auth: AuthContext, itemId?: string) {
    const rows = await this.prisma.share.findMany({
      where: { userId: auth.userId, ...(itemId ? { itemId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((r) => this.summary(r));
  }

  async revoke(auth: AuthContext, id: string) {
    const share = await this.prisma.share.findFirst({ where: { id, userId: auth.userId } });
    if (!share) throw new NotFoundException();
    await this.prisma.share.update({
      where: { id },
      data: { revokedAt: new Date(), ciphertext: null, burnedAt: new Date() },
    });
    await this.activity.log(auth, "share.revoked", {
      item: { id: share.itemId ?? share.id, name: share.label, type: "SHARE" },
    });
  }

  // ─── Public: the recipient's side ──────────────────────────────────────────

  async meta(id: string): Promise<ShareMeta> {
    const s = await this.prisma.share.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("This link does not exist");
    const st = status(s);
    const available = st === "active" && !!s.ciphertext;
    return {
      id: s.id,
      expiresAt: s.expiresAt.toISOString(),
      viewsLeft: s.maxViews === null ? null : Math.max(0, s.maxViews - s.viewCount),
      requiresPassphrase: !!s.accessHash,
      passphraseSalt: s.passphraseSalt,
      available,
      ...(available ? {} : { reason: st === "active" ? "used" : st }),
    };
  }

  /**
   * Hands out the ciphertext and counts the view in one statement, so two
   * people opening a one-time link at once cannot both get it. The last
   * allowed view deletes the ciphertext.
   */
  async open(
    id: string,
    accessToken: string | undefined,
    client: ClientInfo,
  ): Promise<{ ciphertext: string; viewsLeft: number | null }> {
    const s = await this.prisma.share.findUnique({ where: { id } });
    if (!s || status(s) !== "active" || !s.ciphertext)
      throw new NotFoundException("This link has expired or was already used");
    if (s.accessHash) {
      if (!accessToken || !safeEqual(sha256(accessToken), s.accessHash)) {
        // Atomic, so parallel guesses each count. Too many destroy the share.
        const { failedAttempts: failed } = await this.prisma.share.update({
          where: { id },
          data: { failedAttempts: { increment: 1 } },
          select: { failedAttempts: true },
        });
        if (failed >= MAX_WRONG_PASSPHRASE)
          await this.prisma.share.update({
            where: { id },
            data: { ciphertext: null, burnedAt: new Date() },
          });
        throw new ForbiddenException({
          message:
            failed >= MAX_WRONG_PASSPHRASE
              ? "Too many wrong passphrases. This link is now closed."
              : "Wrong passphrase",
          code: "BAD_PASSPHRASE",
        });
      }
    }
    const rows = await this.prisma.$queryRaw<
      {
        ciphertext: string | null;
        viewCount: number;
        maxViews: number | null;
        userId: string;
        label: string;
        itemId: string | null;
      }[]
    >`
      UPDATE shares SET "viewCount" = "viewCount" + 1, "lastViewedAt" = now()
      WHERE id = ${id}::uuid AND ciphertext IS NOT NULL AND "revokedAt" IS NULL AND "expiresAt" > now()
        AND ("maxViews" IS NULL OR "viewCount" < "maxViews")
      RETURNING ciphertext, "viewCount", "maxViews", "userId", label, "itemId"`;
    const row = rows[0];
    if (!row?.ciphertext) throw new NotFoundException("This link has expired or was already used");
    if (row.maxViews !== null && row.viewCount >= row.maxViews) {
      await this.prisma.share.update({
        where: { id },
        data: { ciphertext: null, burnedAt: new Date() },
      });
    }
    // The owner sees each view in their activity, with where it came from.
    await this.activity.log(
      { userId: row.userId, ip: client.ip, userAgent: client.userAgent },
      "share.viewed",
      {
        item: { id: row.itemId ?? id, name: row.label, type: "SHARE" },
        metadata: { count: row.viewCount },
      },
    );
    return {
      ciphertext: row.ciphertext,
      viewsLeft: row.maxViews === null ? null : row.maxViews - row.viewCount,
    };
  }
}

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

@UseGuards(VaultUnlockedGuard)
@Controller("shares")
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Post() create(@Auth() a: AuthContext, @Body() dto: CreateShareDto) {
    return this.shares.create(a, dto);
  }
  @Get() list(@Auth() a: AuthContext) {
    return this.shares.list(a);
  }
  @Delete(":id") @HttpCode(204) async revoke(@Auth() a: AuthContext, @Id() id: string) {
    await this.shares.revoke(a, id);
  }
}

@Public()
@Controller("public/shares")
export class PublicSharesController {
  constructor(private readonly shares: SharesService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(":id")
  meta(@Id() id: string) {
    return this.shares.meta(id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(":id/open")
  @HttpCode(200)
  open(@Id() id: string, @Body() dto: OpenShareDto, @Client() client: ClientInfo) {
    return this.shares.open(id, dto.accessToken, client);
  }
}

@Module({ controllers: [SharesController, PublicSharesController], providers: [SharesService] })
export class SharesModule {}
