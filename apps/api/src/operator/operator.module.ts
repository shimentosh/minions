import type { OperatorOverview, OperatorUserRow } from "@minions/core";
import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { ActivityService } from "../activity/activity.service";
import { Auth, type AuthContext, type AuthedRequest } from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import { PrismaService } from "../common/prisma.service";
import { loadConfig } from "../config";

/**
 * The operator dashboard: how the service is used, for whoever runs it.
 *
 * Who: only accounts whose id is in OPERATOR_USER_IDS (server config, read on
 * every request; ids because email ownership is never verified), with an unlocked vault, and, outside development, with
 * two-factor turned on. Anyone else gets 404, as if it did not exist.
 *
 * What: counts and account metadata (email, name, sign-up date, last active,
 * how many items, imports and workspaces). Never an item, a name of an item, a
 * host, an IP address or anything encrypted; there is nothing decryptable
 * here to show anyway. Every view is written to the operator's activity log.
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!auth) throw new NotFoundException();
    const cfg = loadConfig();
    if (!cfg.operatorUserIds.includes(auth.userId.toLowerCase())) throw new NotFoundException();
    const user = await this.prisma.user.findUnique({
      where: { id: auth.userId },
      select: { twoFactorEnabled: true },
    });
    if (!user) throw new NotFoundException();
    if (!user.twoFactorEnabled && cfg.env !== "development")
      throw new ForbiddenException({
        message: "Turn on two-factor authentication to open the operator dashboard",
        code: "OPERATOR_2FA_REQUIRED",
      });
    return true;
  }
}

class UsersQuery {
  @IsOptional() @IsString() @MaxLength(254) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) offset?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

const DAY = 86_400_000;

@Injectable()
export class OperatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /** Whether the caller may see the dashboard, so the web app knows to show the link. */
  async status(auth: AuthContext) {
    const cfg = loadConfig();
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { twoFactorEnabled: true },
    });
    const listed = cfg.operatorUserIds.includes(auth.userId.toLowerCase());
    return {
      operator: listed,
      needsTwoFactor: listed && !user.twoFactorEnabled && cfg.env !== "development",
    };
  }

  private async activeUsers(since: Date) {
    const rows = await this.prisma.session.groupBy({
      by: ["userId"],
      where: { lastActiveAt: { gte: since } },
    });
    return rows.length;
  }

  async overview(auth: AuthContext): Promise<OperatorOverview> {
    const now = Date.now();
    const days = (n: number) => new Date(now - n * DAY);
    const personal = { vault: { userId: { not: null } }, deletedAt: null };
    const [
      users,
      new7,
      new30,
      twoFactor,
      active1,
      active7,
      active30,
      signups,
      items,
      itemsByType,
      importJobs,
      importsBySource,
      workspaces,
      members,
      sharedItems,
      devices,
      notes,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: days(7) } } }),
      this.prisma.user.count({ where: { createdAt: { gte: days(30) } } }),
      this.prisma.user.count({ where: { twoFactorEnabled: true } }),
      this.activeUsers(days(1)),
      this.activeUsers(days(7)),
      this.activeUsers(days(30)),
      this.prisma.$queryRaw<{ day: Date; n: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS n
        FROM users WHERE "createdAt" >= ${days(30)}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.vaultItem.count({ where: personal }),
      this.prisma.vaultItem.groupBy({ by: ["type"], where: personal, _count: { _all: true } }),
      this.prisma.importJob.aggregate({
        _count: { _all: true },
        _sum: { importedCount: true },
      }),
      this.prisma.importJob.groupBy({
        by: ["source"],
        _count: { _all: true },
        _sum: { importedCount: true },
      }),
      this.prisma.workspace.count(),
      this.prisma.workspaceMember.count({ where: { status: "CONFIRMED" } }),
      this.prisma.vaultItem.count({ where: { vault: { userId: null }, deletedAt: null } }),
      this.prisma.device.groupBy({
        by: ["kind"],
        where: { revokedAt: null },
        _count: { _all: true },
      }),
      this.prisma.note.count({ where: { deletedAt: null } }),
    ]);

    // One point per day for the last 30 days, zeros included.
    const byDay = new Map(signups.map((r) => [r.day.toISOString().slice(0, 10), Number(r.n)]));
    const signupsByDay = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(now - (29 - i) * DAY).toISOString().slice(0, 10);
      return { day: d, count: byDay.get(d) ?? 0 };
    });

    await this.activity.log(auth, "operator.viewed", { metadata: { kind: "overview" } });
    return {
      users: { total: users, new7d: new7, new30d: new30, twoFactor },
      active: { day: active1, week: active7, month: active30 },
      signupsByDay,
      items: {
        total: items,
        notes,
        byType: itemsByType
          .map((r) => ({ type: r.type, count: r._count._all }))
          .sort((a, b) => b.count - a.count),
      },
      imports: {
        jobs: importJobs._count._all,
        importedItems: importJobs._sum.importedCount ?? 0,
        bySource: importsBySource
          .map((r) => ({ source: r.source, jobs: r._count._all, items: r._sum.importedCount ?? 0 }))
          .sort((a, b) => b.items - a.items),
      },
      workspaces: { total: workspaces, members, sharedItems },
      devices: Object.fromEntries(devices.map((d) => [d.kind.toLowerCase(), d._count._all])),
      generatedAt: new Date(now).toISOString(),
    };
  }

  async users(auth: AuthContext, q: UsersQuery) {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const where = q.q
      ? {
          OR: [
            { email: { contains: q.q, mode: "insensitive" as const } },
            { name: { contains: q.q, mode: "insensitive" as const } },
          ],
        }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          twoFactorEnabled: true,
          _count: { select: { importJobs: true, memberships: { where: { status: "CONFIRMED" } } } },
        },
      }),
    ]);
    const ids = rows.map((r) => r.id);
    const [lastActive, itemCounts] = await Promise.all([
      this.prisma.session.groupBy({
        by: ["userId"],
        where: { userId: { in: ids } },
        _max: { lastActiveAt: true },
      }),
      this.prisma.vaultItem.groupBy({
        by: ["vaultId"],
        where: { vault: { userId: { in: ids } }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);
    const vaults = await this.prisma.vault.findMany({
      where: { userId: { in: ids } },
      select: { id: true, userId: true },
    });
    const itemsByVault = new Map(itemCounts.map((c) => [c.vaultId, c._count._all]));
    const itemsByUser = new Map<string, number>();
    for (const v of vaults)
      itemsByUser.set(v.userId!, (itemsByUser.get(v.userId!) ?? 0) + (itemsByVault.get(v.id) ?? 0));
    const active = new Map(lastActive.map((l) => [l.userId, l._max.lastActiveAt]));

    await this.activity.log(auth, "operator.viewed", {
      metadata: { kind: "users", count: rows.length },
    });
    const items: OperatorUserRow[] = rows.map((r) => ({
      email: r.email,
      name: r.name,
      createdAt: r.createdAt.toISOString(),
      lastActiveAt: active.get(r.id)?.toISOString() ?? null,
      items: itemsByUser.get(r.id) ?? 0,
      imports: r._count.importJobs,
      workspaces: r._count.memberships,
      twoFactor: r.twoFactorEnabled,
    }));
    return { total, items };
  }
}

@Controller("operator")
export class OperatorController {
  constructor(private readonly operator: OperatorService) {}

  /** Open to every signed-in user: it says only whether *they* are an operator. */
  @Get("status")
  status(@Auth() auth: AuthContext) {
    return this.operator.status(auth);
  }

  @UseGuards(VaultUnlockedGuard, OperatorGuard)
  @Get("overview")
  overview(@Auth() auth: AuthContext) {
    return this.operator.overview(auth);
  }

  @UseGuards(VaultUnlockedGuard, OperatorGuard)
  @Get("users")
  users(@Auth() auth: AuthContext, @Query() q: UsersQuery) {
    return this.operator.users(auth, q);
  }
}

@Module({ controllers: [OperatorController], providers: [OperatorService, OperatorGuard] })
export class OperatorModule {}
