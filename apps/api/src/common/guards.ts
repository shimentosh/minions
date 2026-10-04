import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  ALLOW_PENDING_2FA,
  AuthedRequest,
  CLIENT_HEADER,
  IS_PUBLIC,
  SESSION_COOKIE,
} from "./auth-context";
import { PrismaService } from "./prisma.service";
import { sha256 } from "./server-crypto";

const TOUCH_INTERVAL_MS = 60_000;

/** During a key rotation: reads (except the backup export), the rotation itself and the heartbeat. */
function rotationMayProceed(method: string, path: string): boolean {
  if (path.startsWith("/vault/rotation") || path === "/vault/heartbeat") return true;
  return method === "GET" && path !== "/vault/export";
}

/**
 * Global guard. Resolves the session from the HttpOnly cookie (web) or a
 * bearer token (extension, desktop) and attaches the auth context.
 *
 * Cookie-authenticated requests must carry `X-Minions-Client`, which a
 * cross-site form or image request cannot set: that plus SameSite=Strict is
 * the CSRF defence.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const targets = [context.getHandler(), context.getClass()];

    if (!req.get(CLIENT_HEADER)) throw new ForbiddenException("Missing client header");

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    if (isPublic) return true;

    const header = req.get("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const token = bearer ?? (req.cookies?.[SESSION_COOKIE] as string | undefined);
    if (!token || token.length > 200) throw new UnauthorizedException();

    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: {
        device: { select: { revokedAt: true } },
        user: {
          select: { vaults: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } } },
        },
      },
    });
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt <= now || session.device?.revokedAt) {
      throw new UnauthorizedException();
    }
    const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_2FA, targets);
    if (session.state !== "ACTIVE" && !allowPending)
      throw new UnauthorizedException("Two-factor verification required");

    const vaultId = session.user.vaults[0]?.id;
    if (!vaultId) throw new UnauthorizedException();

    if (now.getTime() - session.lastActiveAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastActiveAt: now } });
      if (session.deviceId) {
        await this.prisma.device.update({
          where: { id: session.deviceId },
          data: { lastActiveAt: now, lastIp: req.ip ?? null },
        });
      }
    }

    req.auth = {
      userId: session.userId,
      vaultId,
      sessionId: session.id,
      deviceId: session.deviceId,
      vaultUnlockedUntil: session.vaultUnlockedUntil,
      bearer: !!bearer,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent")?.slice(0, 300) ?? null,
    };
    return true;
  }
}

/**
 * Required on every route that returns or accepts vault ciphertext. Being
 * signed in is not enough: the session must have been unlocked with the
 * master password within the user's auto-lock window. Each use slides the
 * window forward.
 */
@Injectable()
export class VaultUnlockedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const auth = req.auth;
    if (!auth) throw new UnauthorizedException();
    const now = new Date();
    if (!auth.vaultUnlockedUntil || auth.vaultUnlockedUntil <= now) {
      throw new ForbiddenException({ message: "Vault is locked", code: "VAULT_LOCKED" });
    }
    const [user, vault] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: { autoLockMinutes: true },
      }),
      this.prisma.vault.findUnique({
        where: { id: auth.vaultId },
        select: { pendingProtectedKey: true },
      }),
    ]);
    // While the vault key is being rotated, rows are under two keys: only the
    // rotation itself may write, and no backup may be taken.
    if (vault?.pendingProtectedKey && !rotationMayProceed(req.method, req.path)) {
      throw new ConflictException({
        message: "Your vault key is being changed. Finish it, then try again.",
        code: "ROTATION_IN_PROGRESS",
      });
    }
    const until = new Date(now.getTime() + Math.max(user.autoLockMinutes, 1) * 60_000);
    // Only write when the window moves meaningfully, to keep reads cheap.
    if (until.getTime() - auth.vaultUnlockedUntil.getTime() > 30_000) {
      await this.prisma.session.update({
        where: { id: auth.sessionId },
        data: { vaultUnlockedUntil: until },
      });
      auth.vaultUnlockedUntil = until;
    }
    return true;
  }
}
