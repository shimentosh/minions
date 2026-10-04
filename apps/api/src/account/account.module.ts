import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { ActivityService } from "../activity/activity.service";
import { Auth, type AuthContext } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import { FindingsStore } from "../security/findings-store";
import { SessionsService } from "../sessions/sessions.service";

class SettingsDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  /** 0 = lock as soon as the app is hidden or closed. */
  @IsOptional() @IsIn([0, 1, 5, 15, 30, 60, 240]) autoLockMinutes?: number;
  @IsOptional() @IsIn([15, 30, 60]) clipboardClearSeconds?: number;
  @IsOptional() @IsBoolean() aiEnabled?: boolean;
}

class ActivityQuery {
  @IsOptional() @IsUUID(4) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsUUID(4) itemId?: string;
  @IsOptional() @IsString() @MaxLength(300) actions?: string;
}

class RevokeAllDto {
  @IsOptional() @IsBoolean() includeCurrent?: boolean;
}

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async list(auth: AuthContext) {
    const devices = await this.prisma.device.findMany({
      where: { userId: auth.userId },
      orderBy: { lastActiveAt: "desc" },
      include: {
        sessions: {
          where: { revokedAt: null, state: "ACTIVE", expiresAt: { gt: new Date() } },
          select: { id: true },
        },
      },
    });
    return devices.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      userAgent: d.userAgent,
      lastIp: d.lastIp,
      lastActiveAt: d.lastActiveAt,
      createdAt: d.createdAt,
      revoked: !!d.revokedAt,
      current: d.id === auth.deviceId,
      activeSessions: d.sessions.length,
    }));
  }

  /** Signs the device out everywhere. It can sign in again with the master password (and 2FA). */
  async revoke(auth: AuthContext, id: string) {
    const device = await this.prisma.device.findFirst({ where: { id, userId: auth.userId } });
    if (!device) throw new NotFoundException();
    await this.prisma.$transaction([
      this.prisma.device.update({ where: { id }, data: { revokedAt: new Date() } }),
      this.prisma.session.updateMany({
        where: { deviceId: id, revokedAt: null },
        data: { revokedAt: new Date(), vaultUnlockedUntil: null },
      }),
    ]);
    await this.activity.log(auth, "device.revoked", { metadata: { deviceName: device.name } });
    await this.activity.securityEvent(auth, "device_revoked", "warning", {
      deviceName: device.name,
    });
  }
}

@Controller()
export class AccountController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly devices: DevicesService,
    private readonly sessions: SessionsService,
  ) {}

  @Patch("users/me/settings")
  async settings(@Auth() auth: AuthContext, @Body() dto: SettingsDto) {
    const user = await this.prisma.user.update({
      where: { id: auth.userId },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.autoLockMinutes !== undefined ? { autoLockMinutes: dto.autoLockMinutes } : {}),
        ...(dto.clipboardClearSeconds !== undefined
          ? { clipboardClearSecs: dto.clipboardClearSeconds }
          : {}),
        ...(dto.aiEnabled !== undefined ? { aiEnabled: dto.aiEnabled } : {}),
      },
    });
    const changed = Object.entries(dto)
      .filter(([k, v]) => k !== "name" && v !== undefined)
      .map(([k]) => k);
    if (changed.length)
      await this.activity.securityEvent(auth, "settings_changed", "info", {
        kind: changed.sort().join(","),
        ...(dto.autoLockMinutes !== undefined ? { to: String(dto.autoLockMinutes) } : {}),
      });
    // A shorter auto-lock applies right away to this session.
    if (dto.autoLockMinutes !== undefined && auth.vaultUnlockedUntil) {
      const cap = new Date(Date.now() + Math.max(dto.autoLockMinutes, 1) * 60_000);
      if (auth.vaultUnlockedUntil > cap)
        await this.prisma.session.update({
          where: { id: auth.sessionId },
          data: { vaultUnlockedUntil: cap },
        });
    }
    return {
      name: user.name,
      autoLockMinutes: user.autoLockMinutes,
      clipboardClearSeconds: user.clipboardClearSecs,
      aiEnabled: user.aiEnabled,
    };
  }

  @Get("activity")
  activityList(@Auth() auth: AuthContext, @Query() q: ActivityQuery) {
    return this.activity.list(auth.userId, {
      cursor: q.cursor,
      limit: q.limit ?? 50,
      itemId: q.itemId,
      actions: q.actions?.split(",").filter(Boolean),
    });
  }

  @Get("devices") listDevices(@Auth() auth: AuthContext) {
    return this.devices.list(auth);
  }

  @Delete("devices/:id")
  @HttpCode(204)
  async revokeDevice(@Auth() auth: AuthContext, @Id() id: string) {
    await this.devices.revoke(auth, id);
  }

  @Get("sessions") listSessions(@Auth() auth: AuthContext) {
    return this.sessions.list(auth);
  }

  @Delete("sessions/:id")
  @HttpCode(204)
  async revokeSession(@Auth() auth: AuthContext, @Id() id: string) {
    await this.sessions.revoke(auth, id);
  }

  @Post("sessions/revoke-all")
  @HttpCode(200)
  async revokeAll(@Auth() auth: AuthContext, @Body() dto: RevokeAllDto) {
    return { revoked: await this.sessions.revokeAll(auth, dto.includeCurrent ?? false) };
  }
}

@Global()
@Module({
  providers: [ActivityService, SessionsService, FindingsStore],
  exports: [ActivityService, SessionsService, FindingsStore],
})
export class CoreServicesModule {}

@Module({ controllers: [AccountController], providers: [DevicesService] })
export class AccountModule {}
