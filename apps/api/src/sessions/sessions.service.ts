import { Injectable, NotFoundException } from "@nestjs/common";
import { ActivityService } from "../activity/activity.service";
import type { DeviceDto } from "../auth/auth.dto";
import type { AuthContext, ClientInfo } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import { newToken, sha256 } from "../common/server-crypto";
import { loadConfig } from "../config";
import type { DeviceKind, SessionState } from "../generated/prisma/client";

const KIND: Record<DeviceDto["kind"], DeviceKind> = {
  web: "WEB",
  extension: "EXTENSION",
  desktop: "DESKTOP",
};

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /** Finds or registers the device, flagging a first sign-in from it. */
  async upsertDevice(userId: string, device: DeviceDto, client: ClientInfo) {
    const existing = await this.prisma.device.findUnique({
      where: { userId_clientDeviceId: { userId, clientDeviceId: device.clientDeviceId } },
    });
    if (existing) {
      // Revoking a device ends its sessions. Signing in again from it (with
      // the master password and 2FA) is a fresh authorisation, so it clears.
      return this.prisma.device.update({
        where: { id: existing.id },
        data: {
          name: device.name,
          userAgent: client.userAgent,
          lastIp: client.ip,
          lastActiveAt: new Date(),
          revokedAt: null,
        },
      });
    }
    const isFirst = (await this.prisma.device.count({ where: { userId } })) === 0;
    const created = await this.prisma.device.create({
      data: {
        userId,
        clientDeviceId: device.clientDeviceId,
        name: device.name,
        kind: KIND[device.kind],
        userAgent: client.userAgent,
        lastIp: client.ip,
      },
    });
    const actor = { userId, deviceId: created.id, ...client };
    await this.activity.log(actor, "device.added", {
      metadata: { deviceName: created.name, kind: device.kind },
    });
    if (!isFirst)
      await this.activity.securityEvent(actor, "new_device", "warning", {
        deviceName: created.name,
        kind: device.kind,
      });
    return created;
  }

  async create(
    userId: string,
    deviceId: string,
    state: SessionState,
    client: ClientInfo,
    unlockMinutes: number | null,
  ): Promise<{ token: string; id: string }> {
    const token = newToken();
    const cfg = loadConfig();
    const now = Date.now();
    const expiresAt =
      state === "ACTIVE"
        ? new Date(now + cfg.session.ttlDays * 86_400_000)
        : new Date(now + cfg.session.pending2faMinutes * 60_000);
    const session = await this.prisma.session.create({
      data: {
        userId,
        deviceId,
        tokenHash: sha256(token),
        state,
        expiresAt,
        vaultUnlockedUntil:
          unlockMinutes !== null ? new Date(now + Math.max(unlockMinutes, 1) * 60_000) : null,
        ip: client.ip,
        userAgent: client.userAgent,
      },
    });
    return { token, id: session.id };
  }

  async list(auth: AuthContext) {
    const rows = await this.prisma.session.findMany({
      where: {
        userId: auth.userId,
        revokedAt: null,
        state: "ACTIVE",
        expiresAt: { gt: new Date() },
      },
      include: { device: { select: { name: true, kind: true } } },
      orderBy: { lastActiveAt: "desc" },
    });
    return rows.map((s) => ({
      id: s.id,
      current: s.id === auth.sessionId,
      device: s.device ? { name: s.device.name, kind: s.device.kind } : null,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      expiresAt: s.expiresAt,
      vaultUnlocked: !!s.vaultUnlockedUntil && s.vaultUnlockedUntil > new Date(),
    }));
  }

  async revoke(auth: AuthContext, id: string) {
    const result = await this.prisma.session.updateMany({
      where: { id, userId: auth.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException();
    await this.activity.log(auth, "session.revoked", { metadata: { sessionId: id } });
    await this.activity.securityEvent(auth, "session_revoked", "info", { sessionId: id });
  }

  /** Revokes every other session, or every session including this one. */
  async revokeAll(auth: AuthContext, includeCurrent: boolean): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: {
        userId: auth.userId,
        revokedAt: null,
        ...(includeCurrent ? {} : { id: { not: auth.sessionId } }),
      },
      data: { revokedAt: new Date(), vaultUnlockedUntil: null },
    });
    await this.activity.log(auth, "session.revoked_all", { metadata: { count: result.count } });
    return result.count;
  }
}
