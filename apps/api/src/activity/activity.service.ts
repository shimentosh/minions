import type { ActivityEntry } from "@minions/core";
import { Injectable } from "@nestjs/common";
import type { AuthContext } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import type { Prisma } from "../generated/prisma/client";

export const ACTIONS = [
  "item.viewed",
  "item.revealed",
  "item.created",
  "item.updated",
  "item.deleted",
  "item.restored",
  "item.purged",
  "item.copied",
  "item.autofilled",
  "item.totp_generated",
  "item.version_viewed",
  "item.merged",
  "note.created",
  "note.updated",
  "note.deleted",
  "vault.locked",
  "vault.unlocked",
  "vault.unlock_failed",
  "vault.exported",
  "auth.login",
  "auth.logout",
  "auth.login_failed",
  "auth.registered",
  "device.added",
  "device.linked",
  "device.revoked",
  "session.revoked",
  "session.revoked_all",
  "import.completed",
  "share.created",
  "share.viewed",
  "share.revoked",
  "item.shared",
  "item.access_removed",
  "item.access_changed",
  "item.rekeyed",
  "workspace.created",
  "workspace.renamed",
  "workspace.deleted",
  "workspace.rekeyed",
  "workspace.member_invited",
  "workspace.invitation_declined",
  "workspace.member_joined",
  "workspace.member_confirmed",
  "workspace.member_removed",
  "workspace.member_left",
  "workspace.role_changed",
  "workspace.folder_created",
  "workspace.folder_deleted",
  "operator.viewed",
] as const;
export type Action = (typeof ACTIONS)[number];

/** Client-reported usage the API accepts from `POST /activity`. Anything else is server-only. */
export const CLIENT_ACTIONS: readonly Action[] = [
  "item.copied",
  "item.autofilled",
  "item.totp_generated",
  "item.revealed",
];

export const SECURITY_EVENTS = [
  "new_device",
  "login_failed",
  "account_locked",
  "master_password_changed",
  "two_factor_enabled",
  "two_factor_disabled",
  "recovery_code_used",
  "recovery_codes_regenerated",
  "session_revoked",
  "device_revoked",
  "emergency_lock",
  "unlock_failed",
  "settings_changed",
  "vault_key_rotation_started",
  "vault_key_rotated",
  "email_verified",
] as const;
export type SecurityEventType = (typeof SECURITY_EVENTS)[number];

type Actor = Pick<AuthContext, "userId"> &
  Partial<Pick<AuthContext, "deviceId" | "sessionId" | "ip" | "userAgent" | "workspaceId">>;

// Metadata is for ids, counts and labels. Anything else is refused here so a
// careless caller cannot put a value into the log.
const SAFE_META_KEYS = new Set([
  "field",
  "fieldLabel",
  "count",
  "source",
  "kind",
  "reason",
  "from",
  "to",
  "revision",
  "device",
  "deviceName",
  "sessionId",
  "mergedInto",
  "jobId",
  "imported",
  "skipped",
  "via",
  "type",
  // Workspace audit: the other person involved, and what changed. Labels only.
  "member",
  "permission",
  "role",
  "workspace",
  "workspaceShared",
]);

function safeMetadata(meta?: Record<string, unknown>): Prisma.InputJsonValue | undefined {
  if (!meta) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!SAFE_META_KEYS.has(k)) continue;
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 120);
  }
  return out;
}

@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async log(
    actor: Actor,
    action: Action,
    opts: {
      item?: { id: string; name: string; type: string };
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await this.prisma.activityLog.create({
      data: {
        userId: actor.userId,
        action,
        itemId: opts.item?.id,
        itemName: opts.item?.name,
        itemType: opts.item?.type,
        deviceId: actor.deviceId ?? null,
        sessionId: actor.sessionId ?? null,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: safeMetadata(opts.metadata),
        workspaceId: actor.workspaceId ?? null,
      },
    });
  }

  /**
   * A workspace's audit log, newest first, with who did each thing. Callers
   * decide who may read it (admins: everything; item managers: their item).
   */
  async listWorkspace(
    workspaceId: string,
    opts: { cursor?: string; limit: number; itemId?: string; userId?: string },
  ): Promise<{ items: ActivityEntry[]; nextCursor: string | null }> {
    const rows = await this.prisma.activityLog.findMany({
      where: {
        workspaceId,
        ...(opts.itemId ? { itemId: opts.itemId } : {}),
        ...(opts.userId ? { userId: opts.userId } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    const deviceIds = [...new Set(rows.map((r) => r.deviceId).filter((d): d is string => !!d))];
    const devices = await this.prisma.device.findMany({
      where: { id: { in: deviceIds } },
      select: { id: true, kind: true },
    });
    // Other people's device names are theirs; the log says only which kind of client.
    const kinds = new Map(devices.map((d) => [d.id, d.kind]));
    const KIND_LABEL = { WEB: "Web app", EXTENSION: "Browser extension", DESKTOP: "Desktop app" };
    const page = rows.slice(0, opts.limit);
    return {
      items: page.map((r) => {
        const kind = r.deviceId ? kinds.get(r.deviceId) : undefined;
        return {
          id: r.id,
          action: r.action,
          itemId: r.itemId,
          itemName: r.itemName,
          itemType: r.itemType,
          device: kind ? KIND_LABEL[kind] : null,
          ip: null,
          createdAt: r.createdAt.toISOString(),
          metadata: (r.metadata as Record<string, unknown> | null) ?? null,
          actor: r.user,
        };
      }),
      nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null,
    };
  }

  async securityEvent(
    actor: Actor,
    type: SecurityEventType,
    severity: "info" | "warning" | "critical",
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.securityEvent.create({
      data: {
        userId: actor.userId,
        type,
        severity,
        deviceId: actor.deviceId ?? null,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: safeMetadata(metadata),
      },
    });
  }

  async list(
    userId: string,
    opts: { cursor?: string; limit: number; itemId?: string; actions?: string[] },
  ): Promise<{ items: ActivityEntry[]; nextCursor: string | null }> {
    const rows = await this.prisma.activityLog.findMany({
      where: {
        userId,
        ...(opts.itemId ? { itemId: opts.itemId } : {}),
        ...(opts.actions?.length ? { action: { in: opts.actions } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const deviceIds = [...new Set(rows.map((r) => r.deviceId).filter((d): d is string => !!d))];
    const devices = await this.prisma.device.findMany({
      where: { id: { in: deviceIds }, userId },
      select: { id: true, name: true },
    });
    const names = new Map(devices.map((d) => [d.id, d.name]));
    const page = rows.slice(0, opts.limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        action: r.action,
        itemId: r.itemId,
        itemName: r.itemName,
        itemType: r.itemType,
        device: r.deviceId ? (names.get(r.deviceId) ?? null) : null,
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      })),
      nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null,
    };
  }
}
