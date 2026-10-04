import {
  type DashboardSummary,
  type FindingType,
  type SecurityFinding,
  type SecurityOverview,
  type SecurityScoreFactor,
} from "@minions/core";
import { Injectable } from "@nestjs/common";
import { ActivityService } from "../activity/activity.service";
import type { AuthContext } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import { toSummary } from "../vault-items/items.service";
import { FindingsStore, UNUSED_DAYS } from "./findings-store";

const DAY = 86_400_000;
const PAGE = 50;

interface RecordRow {
  key: string;
  type: FindingType;
  severity: SecurityFinding["severity"];
  title: string;
  detail: string;
  itemIds: string[];
  dismissed: boolean;
}

type Counted = { type: FindingType; n: bigint }[];

@Injectable()
export class SecurityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly store: FindingsStore,
  ) {}

  /** Attaches name/type/subtitle for the items one page of findings refers to. */
  private async hydrate(
    vaultId: string,
    rows: RecordRow[],
    maxItems = 500,
  ): Promise<SecurityFinding[]> {
    const ids = [...new Set(rows.flatMap((r) => r.itemIds.slice(0, maxItems)))];
    const items = ids.length
      ? await this.prisma.vaultItem.findMany({
          where: { vaultId, id: { in: ids } },
          select: { id: true, name: true, type: true, username: true, provider: true, host: true },
        })
      : [];
    const byId = new Map(
      items.map((i) => [
        i.id,
        { id: i.id, name: i.name, type: i.type, subtitle: i.username ?? i.provider ?? i.host },
      ]),
    );
    return rows.map((r) => ({
      key: r.key,
      type: r.type,
      severity: r.severity,
      title: r.title,
      detail: r.detail,
      dismissed: r.dismissed,
      items: r.itemIds
        .slice(0, maxItems)
        .map((id) => byId.get(id))
        .filter((i): i is NonNullable<typeof i> => !!i),
      itemCount: r.itemIds.length,
    }));
  }

  /**
   * Score, counts and the first page of each finding type. Findings are
   * precomputed by FindingsStore; dismissals are applied here so they take
   * effect at once.
   */
  async overview(auth: AuthContext, perType = PAGE): Promise<SecurityOverview> {
    const vaultId = auth.vaultId;
    const { refreshing } = await this.store.ensureFresh(vaultId);
    const snap = await this.prisma.securitySnapshot.findUniqueOrThrow({ where: { vaultId } });

    const [counts, affected, totals, page] = await Promise.all([
      this.prisma.$queryRaw<Counted>`
        SELECT r.type, SUM(CASE WHEN r.type IN ('reused_password', 'duplicate') THEN cardinality(r."itemIds") ELSE 1 END) AS n
        FROM security_finding_records r
        WHERE r."vaultId" = ${vaultId}::uuid
          AND NOT EXISTS (SELECT 1 FROM security_findings s WHERE s."vaultId" = r."vaultId" AND s.key = r.key)
        GROUP BY r.type`,
      this.prisma.$queryRaw<Counted>`
        SELECT r.type, COUNT(DISTINCT x) AS n
        FROM security_finding_records r, unnest(r."itemIds") AS x
        WHERE r."vaultId" = ${vaultId}::uuid
          AND NOT EXISTS (SELECT 1 FROM security_findings s WHERE s."vaultId" = r."vaultId" AND s.key = r.key)
        GROUP BY r.type`,
      this.prisma.$queryRaw<Counted>`
        SELECT type, COUNT(*) AS n FROM security_finding_records WHERE "vaultId" = ${vaultId}::uuid GROUP BY type`,
      this.prisma.$queryRaw<RecordRow[]>`
        SELECT key, type, severity, title, detail, "itemIds", dismissed FROM (
          SELECT r.*,
                 EXISTS (SELECT 1 FROM security_findings s WHERE s."vaultId" = r."vaultId" AND s.key = r.key) AS dismissed,
                 ROW_NUMBER() OVER (PARTITION BY r.type ORDER BY r.position) AS rn
          FROM security_finding_records r WHERE r."vaultId" = ${vaultId}::uuid
        ) t WHERE rn <= ${perType} ORDER BY position`,
    ]);

    const toMap = (rows: Counted) =>
      Object.fromEntries(rows.map((r) => [r.type, Number(r.n)])) as Partial<
        Record<FindingType, number>
      >;
    const hit = toMap(affected);
    const a = (t: FindingType) => hit[t] ?? 0;
    const factor = (
      label: string,
      weight: number,
      total: number,
      bad: number,
      okText: string,
      badText: string,
    ): SecurityScoreFactor | null =>
      total === 0
        ? null
        : {
            label,
            weight,
            ok: bad === 0,
            detail: bad === 0 ? okText : badText,
            score: Math.max(0, total - bad) / total,
          };
    const stale = a("expired") + a("expiring") + a("old_password");
    const messy = a("duplicate") + a("incomplete");
    const factors = [
      factor(
        "Strong passwords",
        30,
        snap.passwordItems,
        a("weak_password"),
        "No weak passwords",
        `${a("weak_password")} weak password(s)`,
      ),
      factor(
        "Unique passwords",
        25,
        snap.passwordItems,
        a("reused_password"),
        "Every password is unique",
        `${a("reused_password")} item(s) share a password`,
      ),
      factor(
        "Two-factor coverage",
        20,
        snap.twoFactorEligible,
        a("missing_2fa"),
        "2FA saved for every account that supports it",
        `${a("missing_2fa")} account(s) without 2FA`,
      ),
      factor(
        "Fresh credentials",
        15,
        snap.totalItems,
        stale,
        "Nothing expired or overdue for rotation",
        `${stale} expired, expiring or old`,
      ),
      factor(
        "Tidy vault",
        10,
        snap.totalItems,
        messy,
        "No duplicates or incomplete items",
        `${messy} duplicate or incomplete`,
      ),
    ].filter((f): f is SecurityScoreFactor => !!f);
    const weightSum = factors.reduce((sum, f) => sum + f.weight, 0);
    const score = weightSum
      ? Math.round((factors.reduce((sum, f) => sum + f.weight * f.score, 0) / weightSum) * 100)
      : null;

    return {
      score,
      factors,
      counts: toMap(counts),
      findingTotals: toMap(totals),
      findings: await this.hydrate(vaultId, page, 12),
      totalItems: snap.totalItems,
      computedAt: snap.computedAt.toISOString(),
      refreshing,
    };
  }

  /** One page of one finding type, for "show more". */
  async listFindings(
    auth: AuthContext,
    type: FindingType,
    offset: number,
    limit: number,
  ): Promise<SecurityFinding[]> {
    await this.store.ensureFresh(auth.vaultId);
    const rows = await this.prisma.$queryRaw<RecordRow[]>`
      SELECT r.key, r.type, r.severity, r.title, r.detail, r."itemIds",
             EXISTS (SELECT 1 FROM security_findings s WHERE s."vaultId" = r."vaultId" AND s.key = r.key) AS dismissed
      FROM security_finding_records r
      WHERE r."vaultId" = ${auth.vaultId}::uuid AND r.type = ${type}
      ORDER BY r.position OFFSET ${offset} LIMIT ${limit}`;
    return this.hydrate(auth.vaultId, rows);
  }

  /** Open findings that are not low severity, for the dashboard. */
  async openIssues(vaultId: string): Promise<number> {
    await this.store.ensureFresh(vaultId);
    const [row] = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM security_finding_records r
      WHERE r."vaultId" = ${vaultId}::uuid AND r.severity <> 'low'
        AND NOT EXISTS (SELECT 1 FROM security_findings s WHERE s."vaultId" = r."vaultId" AND s.key = r.key)`;
    return Number(row?.n ?? 0);
  }

  async setFindingState(
    auth: AuthContext,
    key: string,
    status: "dismissed" | "keep_separate" | null,
  ) {
    if (status === null) {
      await this.prisma.securityFindingState.deleteMany({ where: { vaultId: auth.vaultId, key } });
      return;
    }
    await this.prisma.securityFindingState.upsert({
      where: { vaultId_key: { vaultId: auth.vaultId, key } },
      create: { vaultId: auth.vaultId, key, status },
      update: { status },
    });
  }

  async events(auth: AuthContext, limit = 50) {
    const rows = await this.prisma.securityEvent.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    const deviceIds = [...new Set(rows.map((r) => r.deviceId).filter((d): d is string => !!d))];
    const devices = new Map(
      (
        await this.prisma.device.findMany({
          where: { id: { in: deviceIds } },
          select: { id: true, name: true },
        })
      ).map((d) => [d.id, d.name]),
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      severity: r.severity,
      device: r.deviceId ? (devices.get(r.deviceId) ?? null) : null,
      ip: r.ip,
      userAgent: r.userAgent,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async dashboard(auth: AuthContext): Promise<DashboardSummary> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { previousVisitAt: true },
    });
    const since = user.previousVisitAt;
    const include = {
      project: { select: { id: true, name: true, color: true } },
      collection: { select: { id: true, name: true, color: true } },
      tags: { select: { tag: { select: { name: true } } } },
    };
    const base = { vaultId: auth.vaultId, deletedAt: null };
    const unusedBefore = new Date(Date.now() - UNUSED_DAYS * DAY);
    const [
      created,
      updated,
      devices,
      favorites,
      recent,
      frequent,
      neverUsed,
      projects,
      activity,
      openIssues,
    ] = await Promise.all([
      since
        ? this.prisma.vaultItem.count({ where: { ...base, createdAt: { gt: since } } })
        : Promise.resolve(0),
      since
        ? this.prisma.vaultItem.count({
            where: { ...base, updatedAt: { gt: since }, createdAt: { lte: since } },
          })
        : Promise.resolve(0),
      since
        ? this.prisma.device.count({ where: { userId: auth.userId, createdAt: { gt: since } } })
        : Promise.resolve(0),
      this.prisma.vaultItem.findMany({
        where: { ...base, favorite: true },
        include,
        orderBy: { name: "asc" },
        take: 8,
      }),
      this.prisma.vaultItem.findMany({
        where: { ...base, lastAccessedAt: { not: null } },
        include,
        orderBy: { lastAccessedAt: "desc" },
        take: 6,
      }),
      this.prisma.vaultItem.findMany({
        where: { ...base, accessCount: { gt: 0 } },
        include,
        orderBy: { accessCount: "desc" },
        take: 5,
      }),
      this.prisma.vaultItem.count({
        where: {
          ...base,
          OR: [
            { lastAccessedAt: { lt: unusedBefore } },
            { lastAccessedAt: null, createdAt: { lt: unusedBefore } },
          ],
        },
      }),
      this.prisma.project.findMany({
        where: { vaultId: auth.vaultId, archivedAt: null },
        include: { _count: { select: { items: { where: { deletedAt: null } }, usedBy: true } } },
        orderBy: { updatedAt: "desc" },
        take: 8,
      }),
      this.activity.list(auth.userId, { limit: 8 }),
      this.openIssues(auth.vaultId),
    ]);
    return {
      sinceLastVisit: {
        since: since?.toISOString() ?? null,
        created,
        updated,
        devices,
        openIssues,
      },
      favorites: favorites.map(toSummary),
      recent: recent.map(toSummary),
      frequent: frequent.map(toSummary),
      neverUsedCount: neverUsed,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        itemCount: p._count.items + p._count.usedBy,
      })),
      activity: activity.items,
    };
  }
}
