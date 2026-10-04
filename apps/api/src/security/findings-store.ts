import { createHash } from "node:crypto";
import {
  type FindingType,
  findProviderByHost,
  findProviderByName,
  getItemType,
  registrableDomain,
  type SecurityFinding,
} from "@minions/core";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";

const DAY = 86_400_000;
export const UNUSED_DAYS = 180;
export const OLD_PASSWORD_DAYS = 365;
export const EXPIRING_DAYS = 30;
/** Expiry and "unused" depend on today's date, so a snapshot ages out on its own. */
const MAX_AGE_MS = 60 * 60_000;
const DEBOUNCE_MS = 1500;

export const SEVERITY: Record<FindingType, SecurityFinding["severity"]> = {
  reused_password: "high",
  weak_password: "high",
  expired: "high",
  missing_2fa: "medium",
  expiring: "medium",
  duplicate: "medium",
  old_password: "low",
  unused: "low",
  incomplete: "low",
};

export const FINDING_ORDER: FindingType[] = [
  "reused_password",
  "weak_password",
  "expired",
  "missing_2fa",
  "expiring",
  "duplicate",
  "old_password",
  "incomplete",
  "unused",
];

interface Row {
  id: string;
  name: string;
  type: string;
  host: string | null;
  username: string | null;
  provider: string | null;
  status: string | null;
  hasTotp: boolean;
  passwordStrength: number | null;
  passwordFingerprint: string | null;
  passwordUpdatedAt: Date | null;
  expiresAt: Date | null;
  lastAccessedAt: Date | null;
  createdAt: Date;
  keys: string[] | null;
}

interface ComputedFinding {
  key: string;
  type: FindingType;
  title: string;
  detail: string;
  itemIds: string[];
}

/**
 * Keeps each vault's findings precomputed in `security_finding_records`.
 *
 * Any change to the vault marks the snapshot dirty; a debounced job in this
 * process rebuilds it, and any instance rebuilds on read if it finds the
 * snapshot dirty or older than an hour. Reads are then plain indexed SQL, so
 * the Security Center stays fast at 100k items.
 */
@Injectable()
export class FindingsStore implements OnModuleDestroy {
  private readonly logger = new Logger("Findings");
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly prisma: PrismaService) {}

  onModuleDestroy() {
    for (const t of this.timers.values()) clearTimeout(t);
  }

  /** Call after anything that changes items, fields or relations in a vault. */
  async markDirty(vaultId: string): Promise<void> {
    await this.prisma.securitySnapshot.updateMany({
      where: { vaultId },
      data: { dirtyAt: new Date() },
    });
    clearTimeout(this.timers.get(vaultId));
    const timer = setTimeout(() => {
      this.timers.delete(vaultId);
      this.refresh(vaultId).catch((e) =>
        this.logger.warn(`Background refresh failed: ${(e as Error).name}`),
      );
    }, DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(vaultId, timer);
  }

  /**
   * Waits only when there is no snapshot at all. A stale one is served as is
   * while a rebuild runs in the background (changes already scheduled one),
   * so reads stay fast however large the vault is.
   */
  async ensureFresh(vaultId: string): Promise<{ refreshing: boolean }> {
    const snap = await this.prisma.securitySnapshot.findUnique({ where: { vaultId } });
    if (!snap) {
      await this.refresh(vaultId);
      return { refreshing: false };
    }
    const fresh =
      (!snap.dirtyAt || snap.dirtyAt <= snap.computedAt) &&
      Date.now() - snap.computedAt.getTime() < MAX_AGE_MS;
    if (fresh) return { refreshing: false };
    // Small vaults rebuild in milliseconds: just do it inline.
    if (snap.totalItems < 2000) {
      await this.refresh(vaultId);
      return { refreshing: false };
    }
    void this.refresh(vaultId).catch((e) =>
      this.logger.warn(`Refresh failed: ${(e as Error).name}`),
    );
    return { refreshing: true };
  }

  refresh(vaultId: string): Promise<void> {
    const existing = this.running.get(vaultId);
    if (existing) return existing;
    const job = this.rebuild(vaultId).finally(() => this.running.delete(vaultId));
    this.running.set(vaultId, job);
    return job;
  }

  private async rebuild(vaultId: string): Promise<void> {
    const startedAt = new Date();
    // One flat query with the field keys aggregated, instead of a relation
    // fetch that would send 100k ids back to the database.
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT i.id, i.name, i.type, i.host, i.username, i.provider, i.status, i."hasTotp",
             i."passwordStrength", i."passwordFingerprint", i."passwordUpdatedAt", i."expiresAt",
             i."lastAccessedAt", i."createdAt",
             -- Per-row lookup on the (itemId, key) index: a stable plan even
             -- right after a bulk import, before statistics catch up.
             (SELECT array_agg(f.key) FROM vault_item_fields f WHERE f."itemId" = i.id) AS keys
      FROM vault_items i
      WHERE i."vaultId" = ${vaultId}::uuid AND i."deletedAt" IS NULL`;
    const covered = await this.prisma.$queryRaw<{ toItemId: string }[]>`
      SELECT r."toItemId" FROM vault_item_relations r
      JOIN vault_items i ON i.id = r."toItemId"
      WHERE r.kind = 'TWO_FACTOR_FOR' AND i."vaultId" = ${vaultId}::uuid`;

    const loadedAt = Date.now();
    const { findings, passwordItems, twoFactorEligible } = computeFindings(
      rows,
      new Set(covered.map((c) => c.toItemId)),
    );

    await this.prisma.$transaction(
      async (tx) => {
        await tx.securityFindingRecord.deleteMany({ where: { vaultId } });
        // Column arrays + unnest: one statement per 20k rows instead of
        // thousands of parameter sets. Item ids travel comma-joined.
        for (let i = 0; i < findings.length; i += 20_000) {
          const chunk = findings.slice(i, i + 20_000);
          await tx.$executeRaw`
            INSERT INTO security_finding_records (id, "vaultId", key, type, severity, title, detail, "itemIds", position)
            SELECT gen_random_uuid(), ${vaultId}::uuid, k, t, s, ti, d, string_to_array(ids, ','), p
            FROM unnest(
              ${chunk.map((f) => f.key)}::text[],
              ${chunk.map((f) => f.type)}::text[],
              ${chunk.map((f) => SEVERITY[f.type])}::text[],
              ${chunk.map((f) => f.title.slice(0, 300))}::text[],
              ${chunk.map((f) => f.detail.slice(0, 500))}::text[],
              ${chunk.map((f) => f.itemIds.join(","))}::text[],
              ${chunk.map((_, j) => i + j)}::int[]
            ) AS u(k, t, s, ti, d, ids, p)`;
        }
        await tx.securitySnapshot.upsert({
          where: { vaultId },
          create: {
            vaultId,
            computedAt: startedAt,
            totalItems: rows.length,
            passwordItems,
            twoFactorEligible,
          },
          update: {
            computedAt: startedAt,
            totalItems: rows.length,
            passwordItems,
            twoFactorEligible,
          },
        });
      },
      { timeout: 120_000 },
    );
    this.logger.debug(
      `vault rebuilt: ${rows.length} items, ${findings.length} findings; load ${loadedAt - startedAt.getTime()} ms, total ${Date.now() - startedAt.getTime()} ms`,
    );
  }
}

/** Pure: the findings for a set of items. Exported for tests and benchmarks. */
export function computeFindings(rows: Row[], coveredBy2fa: Set<string>, now = Date.now()) {
  const findings: ComputedFinding[] = [];
  const add = (type: FindingType, key: string, title: string, detail: string, items: Row[]) =>
    findings.push({ key, type, title, detail, itemIds: items.map((r) => r.id) });

  const withPassword = rows.filter((r) => r.passwordFingerprint || r.passwordStrength !== null);
  const byFingerprint = new Map<string, Row[]>();
  for (const r of withPassword) {
    if (r.passwordStrength !== null && r.passwordStrength <= 1) {
      add(
        "weak_password",
        `weak:${r.id}`,
        `Weak password: ${r.name}`,
        "Easy to guess. Generate a new one and update it on the site.",
        [r],
      );
    }
    if (r.passwordUpdatedAt && now - r.passwordUpdatedAt.getTime() > OLD_PASSWORD_DAYS * DAY) {
      const years = Math.floor((now - r.passwordUpdatedAt.getTime()) / (365 * DAY));
      add(
        "old_password",
        `old:${r.id}`,
        `Old password: ${r.name}`,
        `Not changed in over ${years} year(s).`,
        [r],
      );
    }
    if (r.passwordFingerprint) {
      const group = byFingerprint.get(r.passwordFingerprint);
      if (group) group.push(r);
      else byFingerprint.set(r.passwordFingerprint, [r]);
    }
  }
  for (const [fp, group] of byFingerprint) {
    if (group.length > 1) {
      add(
        "reused_password",
        `reused:${fp.slice(0, 16)}`,
        `Password used on ${group.length} items`,
        "One leak exposes all of them. Give each its own password.",
        group,
      );
    }
  }

  // 2FA: only for logins at services known to offer it, and not when a
  // separate authenticator item or a 2FA relation covers it.
  const totpProviders = new Set(
    rows
      .filter((r) => r.type === "TOTP" || r.type === "RECOVERY_CODE")
      .map((r) => (r.provider ?? r.name).toLowerCase()),
  );
  let twoFactorEligible = 0;
  for (const r of rows) {
    if (r.type !== "LOGIN") continue;
    const provider = findProviderByHost(r.host) ?? findProviderByName(r.provider ?? r.name);
    if (!provider) continue;
    twoFactorEligible++;
    if (r.hasTotp || coveredBy2fa.has(r.id)) continue;
    if (totpProviders.has(provider.name.toLowerCase()) || totpProviders.has(r.name.toLowerCase()))
      continue;
    add(
      "missing_2fa",
      `2fa:${r.id}`,
      `No 2FA saved: ${r.name}`,
      "Turn on two-factor authentication for this account and save the code here.",
      [r],
    );
  }

  const dupBuckets = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.expiresAt) {
      const left = r.expiresAt.getTime() - now;
      if (left < 0)
        add(
          "expired",
          `expired:${r.id}`,
          `Expired: ${r.name}`,
          `Expired ${Math.ceil(-left / DAY)} day(s) ago. Rotate or remove it.`,
          [r],
        );
      else if (left < EXPIRING_DAYS * DAY)
        add(
          "expiring",
          `expiring:${r.id}`,
          `Expires soon: ${r.name}`,
          `Expires in ${Math.ceil(left / DAY)} day(s).`,
          [r],
        );
    } else if (r.status === "Expired") {
      add(
        "expired",
        `expired:${r.id}`,
        `Marked expired: ${r.name}`,
        "Rotate it or move it to the trash.",
        [r],
      );
    }
    const lastUse = (r.lastAccessedAt ?? r.createdAt).getTime();
    if (now - lastUse > UNUSED_DAYS * DAY) {
      add(
        "unused",
        `unused:${r.id}`,
        `Unused for ${Math.floor((now - lastUse) / DAY)} days: ${r.name}`,
        "Still needed? Review it, archive it in a collection or move it to the trash.",
        [r],
      );
    }
    const def = getItemType(r.type);
    const keys = new Set(r.keys ?? []);
    const missing =
      def?.fields.filter((f) => f.required && !keys.has(f.key)).map((f) => f.label) ?? [];
    if (r.type === "LOGIN" && !keys.has("password")) missing.push("Password");
    if (r.type === "LOGIN" && !keys.has("username") && !keys.has("email"))
      missing.push("Username or email");
    // A url field the server could not parse into a host is a broken link.
    if (
      !r.host &&
      (keys.has("url") || keys.has("base_url") || keys.has("console_url") || keys.has("endpoint"))
    )
      missing.push("a valid website URL");
    if (missing.length)
      add(
        "incomplete",
        `incomplete:${r.id}`,
        `Incomplete: ${r.name}`,
        `Missing ${missing.join(", ").toLowerCase()}.`,
        [r],
      );

    if (r.host && r.username) {
      const k = `${r.type}|${registrableDomain(r.host) ?? r.host}|${r.username.toLowerCase()}`;
      const group = dupBuckets.get(k);
      if (group) group.push(r);
      else dupBuckets.set(k, [r]);
    }
  }
  for (const group of dupBuckets.values()) {
    if (group.length < 2) continue;
    // Stable for the same set of items, and short enough to index.
    const key = `duplicate:${createHash("sha256")
      .update(
        group
          .map((g) => g.id)
          .sort()
          .join(","),
      )
      .digest("hex")
      .slice(0, 32)}`;
    add(
      "duplicate",
      key,
      `Possible duplicates: ${group[0]!.name}`,
      `${group.length} items for ${group[0]!.username} on ${registrableDomain(group[0]!.host!) ?? group[0]!.host}.`,
      group,
    );
  }

  findings.sort((a, b) => FINDING_ORDER.indexOf(a.type) - FINDING_ORDER.indexOf(b.type));
  return { findings, passwordItems: withPassword.length, twoFactorEligible };
}
