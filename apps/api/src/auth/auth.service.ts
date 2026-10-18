import { randomBytes } from "node:crypto";
import {
  type AuthResult,
  base32Encode,
  DEFAULT_KDF,
  type KdfParams,
  type MeResponse,
  totpUri,
  type VaultKeys,
  verifyTotp,
} from "@minions/core";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import { ActivityService } from "../activity/activity.service";
import type { AuthContext, ClientInfo } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import { hmac, serverDecrypt, serverEncrypt, sha256 } from "../common/server-crypto";
import { loadConfig } from "../config";
import { Mailer } from "../mail/mailer";
import { SessionsService } from "../sessions/sessions.service";
import type {
  BackupCodesDto,
  ChangePasswordDto,
  DeviceDto,
  LoginDto,
  RecoverCheckDto,
  RecoverCompleteDto,
  RegisterDto,
} from "./auth.dto";
import { EmailVerificationService } from "./email-verification";

const ARGON = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const LOCK_AFTER = 5;
/** How long each lock lasts: the first after 5 failures in a row, the next after 10, and so on. */
const LOCK_MINUTES = [1, 5, 15, 60];
const MAX_2FA_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;

function badBackupCode() {
  return new BadRequestException({
    message: "That backup code doesn't match this email, or it was already used.",
    code: "BAD_BACKUP_CODE",
  });
}

// Verified against when the email is unknown, so both paths cost the same.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hash(randomBytes(32).toString("base64"), ARGON));

export interface AuthOutcome {
  result: AuthResult;
  /** Set as the HttpOnly cookie for web clients; returned in the body for bearer clients. */
  token: string;
  bearer: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly activity: ActivityService,
    private readonly emailVerification: EmailVerificationService,
    private readonly mailer: Mailer,
  ) {}

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  async prelogin(email: string): Promise<{ kdf: KdfParams }> {
    const user = await this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(email) },
    });
    if (user) {
      return {
        kdf: {
          type: "argon2id",
          memory: user.kdfMemory,
          iterations: user.kdfIterations,
          parallelism: user.kdfParallelism,
          salt: user.kdfSalt,
        },
      };
    }
    // Unknown email: a stable, fake salt so the response does not reveal
    // whether the account exists.
    const salt = hmac(loadConfig().preloginSecret, this.normalizeEmail(email))
      .subarray(0, 16)
      .toString("base64");
    return { kdf: { ...DEFAULT_KDF, salt } };
  }

  private keysFor(
    user: {
      id: string;
      kdfMemory: number;
      kdfIterations: number;
      kdfParallelism: number;
      kdfSalt: string;
      protectedUserKey: string;
      publicKey?: string | null;
      protectedPrivateKey?: string | null;
    },
    vault: { id: string; protectedKey: string; pendingProtectedKey?: string | null },
  ): VaultKeys {
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
      pendingProtectedVaultKey: vault.pendingProtectedKey ?? null,
      publicKey: user.publicKey ?? null,
      protectedPrivateKey: user.protectedPrivateKey ?? null,
    };
  }

  async register(dto: RegisterDto, client: ClientInfo): Promise<AuthOutcome> {
    const email = this.normalizeEmail(dto.email);
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException("An account with this email already exists");
    }
    const authHash = await hash(dto.authKey, ARGON);
    const { user, vault } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          id: dto.userId,
          email,
          name: dto.name.trim(),
          authHash,
          kdfMemory: dto.kdf.memory,
          kdfIterations: dto.kdf.iterations,
          kdfParallelism: dto.kdf.parallelism,
          kdfSalt: dto.kdf.salt,
          protectedUserKey: dto.protectedUserKey,
          lastVisitAt: new Date(),
        },
      });
      const vault = await tx.vault.create({
        data: { id: dto.vaultId, userId: user.id, protectedKey: dto.protectedVaultKey },
      });
      return { user, vault };
    });
    const device = await this.sessions.upsertDevice(user.id, dto.device, client);
    const { token, id } = await this.sessions.create(
      user.id,
      device.id,
      "ACTIVE",
      client,
      user.autoLockMinutes,
    );
    await this.activity.log(
      { userId: user.id, deviceId: device.id, sessionId: id, ...client },
      "auth.registered",
    );
    // Best effort: the account works without it, and the link can be re-sent.
    await this.emailVerification.send(user.id).catch(() => undefined);
    return this.outcome(dto.device, token, { status: "ok", keys: this.keysFor(user, vault) });
  }

  private outcome(device: DeviceDto, token: string, result: AuthResult): AuthOutcome {
    const bearer = device.kind !== "web";
    return { token, bearer, result: bearer ? { ...result, token } : result };
  }

  private assertNotLocked(user: { lockedUntil: Date | null }) {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new HttpException(
        {
          message: `Too many wrong attempts, so sign-in is paused. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or use a backup code.`,
          code: "ACCOUNT_LOCKED",
          retryAt: user.lockedUntil.toISOString(),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * One failed proof of identity: a wrong master password at sign-in or
   * unlock, or a wrong second factor. All of them feed the same per-account
   * counter, incremented atomically so parallel guesses cannot share a count.
   * Every fifth failure in a row locks the account, for 1, 5, 15, then 60
   * minutes, so a typo after a lock ends does not lock it again at once.
   */
  private async registerFailure(
    userId: string,
    actor: Partial<AuthContext> & ClientInfo,
    reason: "password" | "2fa" | "passkey",
  ) {
    const { failedLoginCount: count } = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    const locks = count / LOCK_AFTER;
    const lockedUntil = Number.isInteger(locks)
      ? new Date(Date.now() + LOCK_MINUTES[Math.min(locks, LOCK_MINUTES.length) - 1]! * 60_000)
      : null;
    if (lockedUntil)
      await this.prisma.user.update({ where: { id: userId }, data: { lockedUntil } });
    await this.activity.log({ ...actor, userId }, "auth.login_failed", { metadata: { reason } });
    await this.activity.securityEvent(
      { ...actor, userId },
      lockedUntil ? "account_locked" : "login_failed",
      lockedUntil ? "critical" : "warning",
      { count, reason },
    );
  }

  private async clearFailures(userId: string) {
    await this.prisma.user.updateMany({
      where: { id: userId, OR: [{ failedLoginCount: { gt: 0 } }, { lockedUntil: { not: null } }] },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  }

  async login(dto: LoginDto, client: ClientInfo): Promise<AuthOutcome> {
    const user = await this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(dto.email) },
      include: { vaults: { orderBy: { createdAt: "asc" }, take: 1 } },
    });
    if (!user) {
      await verify(await getDummyHash(), dto.authKey).catch(() => false);
      throw new UnauthorizedException("Invalid email or master password");
    }
    this.assertNotLocked(user);
    if (!(await verify(user.authHash, dto.authKey).catch(() => false))) {
      await this.registerFailure(user.id, client, "password");
      throw new UnauthorizedException("Invalid email or master password");
    }

    const device = await this.sessions.upsertDevice(user.id, dto.device, client);
    const passkeys = await this.prisma.webauthnCredential.count({ where: { userId: user.id } });
    if (user.twoFactorEnabled || passkeys > 0) {
      // The failure counter is cleared only once the second factor passes, so
      // someone who has the password cannot reset it between code guesses.
      const { token } = await this.sessions.create(user.id, device.id, "PENDING_2FA", client, null);
      const methods: ("totp" | "passkey")[] = [];
      if (user.twoFactorEnabled) methods.push("totp");
      if (passkeys > 0) methods.push("passkey");
      return this.outcome(dto.device, token, { status: "two_factor_required", methods });
    }
    await this.clearFailures(user.id);
    const { token, id } = await this.sessions.create(
      user.id,
      device.id,
      "ACTIVE",
      client,
      user.autoLockMinutes,
    );
    await this.markVisit(user.id);
    await this.activity.log(
      { userId: user.id, deviceId: device.id, sessionId: id, ...client },
      "auth.login",
    );
    return this.outcome(dto.device, token, {
      status: "ok",
      keys: this.keysFor(user, user.vaults[0]!),
    });
  }

  private async markVisit(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { lastVisitAt: true },
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { previousVisitAt: user.lastVisitAt, lastVisitAt: new Date() },
    });
  }

  /**
   * A TOTP code is accepted at most once: its time step must be newer than
   * the last one used. The compare-and-set is a single conditional UPDATE,
   * so two requests racing with the same code cannot both pass.
   */
  private async acceptTotp(userId: string, secret: string, code: string): Promise<boolean> {
    const step = await verifyTotp(secret, code);
    if (step === null) return false;
    const r = await this.prisma.user.updateMany({
      where: { id: userId, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
      data: { lastTotpStep: step },
    });
    return r.count === 1;
  }

  private async checkSecondFactor(
    user: { id: string; twoFactorSecretEnc: string | null },
    code: string,
    actor: Partial<AuthContext> & { userId: string },
  ): Promise<boolean> {
    const clean = code.trim();
    if (/^\d{6}$/.test(clean) && user.twoFactorSecretEnc) {
      const secret = serverDecrypt(user.twoFactorSecretEnc, `user:${user.id}:totp`);
      return this.acceptTotp(user.id, secret, clean);
    }
    const normalized = clean.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized.length !== 10) return false;
    // Consumed in one conditional UPDATE: a code works once, even under concurrency.
    const used = await this.prisma.recoveryCode.updateMany({
      where: { userId: user.id, codeHash: sha256(normalized), usedAt: null },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) return false;
    const left = await this.prisma.recoveryCode.count({ where: { userId: user.id, usedAt: null } });
    await this.activity.securityEvent(actor, "recovery_code_used", "warning", { count: left });
    return true;
  }

  /** Counts a failed second factor against both the pending session and the account. */
  async secondFactorFailed(auth: AuthContext, reason: "2fa" | "passkey"): Promise<never> {
    const { twoFactorAttempts: attempts } = await this.prisma.session.update({
      where: { id: auth.sessionId },
      data: { twoFactorAttempts: { increment: 1 } },
      select: { twoFactorAttempts: true },
    });
    if (attempts >= MAX_2FA_ATTEMPTS)
      await this.prisma.session.update({
        where: { id: auth.sessionId },
        data: { revokedAt: new Date() },
      });
    await this.registerFailure(auth.userId, auth, reason);
    throw new UnauthorizedException(
      attempts >= MAX_2FA_ATTEMPTS
        ? "Too many attempts. Sign in again."
        : reason === "2fa"
          ? "Invalid code"
          : "Passkey could not be verified",
    );
  }

  /** A pending sign-in ends as soon as the account is locked. */
  async assertPendingAllowed(auth: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { lockedUntil: true },
    });
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.prisma.session.update({
        where: { id: auth.sessionId },
        data: { revokedAt: new Date() },
      });
      this.assertNotLocked(user);
    }
  }

  async verifySecondFactor(auth: AuthContext, code: string): Promise<AuthResult> {
    const session = await this.prisma.session.findUniqueOrThrow({ where: { id: auth.sessionId } });
    if (session.state !== "PENDING_2FA")
      throw new BadRequestException("Session does not need verification");
    await this.assertPendingAllowed(auth);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await this.checkSecondFactor(user, code, auth)))
      await this.secondFactorFailed(auth, "2fa");
    return this.completeSecondFactor(auth, "2fa");
  }

  /** Marks a pending session as signed in after a code or passkey check. */
  async completeSecondFactor(auth: AuthContext, via: "2fa" | "passkey"): Promise<AuthResult> {
    const session = await this.prisma.session.findUniqueOrThrow({ where: { id: auth.sessionId } });
    if (session.state !== "PENDING_2FA")
      throw new BadRequestException("Session does not need verification");
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      include: { vaults: { orderBy: { createdAt: "asc" }, take: 1 } },
    });
    const cfg = loadConfig();
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        state: "ACTIVE",
        expiresAt: new Date(Date.now() + cfg.session.ttlDays * 86_400_000),
        vaultUnlockedUntil: new Date(Date.now() + Math.max(user.autoLockMinutes, 1) * 60_000),
      },
    });
    await this.clearFailures(user.id);
    await this.markVisit(user.id);
    await this.activity.log(auth, "auth.login", { metadata: { via } });
    return { status: "ok", keys: this.keysFor(user, user.vaults[0]!) };
  }

  async logout(auth: AuthContext) {
    await this.prisma.session.update({
      where: { id: auth.sessionId },
      data: { revokedAt: new Date(), vaultUnlockedUntil: null },
    });
    await this.activity.log(auth, "auth.logout");
  }

  async me(auth: AuthContext): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    const vault = await this.prisma.vault.findUnique({
      where: { id: auth.vaultId },
      select: { name: true },
    });
    const unlocked = !!auth.vaultUnlockedUntil && auth.vaultUnlockedUntil > new Date();
    return {
      user: {
        id: user.id,
        email: user.email,
        emailVerified: !!user.emailVerifiedAt,
        name: user.name,
        twoFactorEnabled: user.twoFactorEnabled,
        passkeyCount: await this.prisma.webauthnCredential.count({ where: { userId: user.id } }),
        createdAt: user.createdAt.toISOString(),
        previousVisitAt: user.previousVisitAt?.toISOString() ?? null,
        autoLockMinutes: user.autoLockMinutes,
        clipboardClearSeconds: user.clipboardClearSecs,
        aiEnabled: user.aiEnabled,
      },
      session: {
        id: auth.sessionId,
        vaultUnlocked: unlocked,
        vaultUnlockedUntil: unlocked ? auth.vaultUnlockedUntil!.toISOString() : null,
      },
      vaultId: auth.vaultId,
      vaultName: vault?.name ?? "Personal vault",
    };
  }

  /** Re-proves the master password. Used for unlock and for sensitive account changes. */
  async verifyAuthKey(auth: AuthContext, authKey: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    this.assertNotLocked(user);
    if (!(await verify(user.authHash, authKey).catch(() => false))) {
      await this.registerFailure(user.id, auth, "password");
      await this.activity.securityEvent(auth, "unlock_failed", "warning");
      throw new ForbiddenException({
        message: "Master password is incorrect",
        code: "BAD_MASTER_PASSWORD",
      });
    }
    await this.clearFailures(user.id);
  }

  // ─── Account 2FA management ────────────────────────────────────────────────

  async setupTwoFactor(auth: AuthContext): Promise<{ secret: string; uri: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (user.twoFactorEnabled)
      throw new ConflictException("Two-factor authentication is already on");
    const secret = base32Encode(randomBytes(20));
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorSecretEnc: serverEncrypt(secret, `user:${user.id}:totp`),
        lastTotpStep: null,
      },
    });
    return { secret, uri: totpUri(secret, user.email) };
  }

  private async newRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.recoveryCode.createMany({
        data: codes.map((c) => ({ userId, codeHash: sha256(c.replace("-", "")) })),
      }),
    ]);
    return codes;
  }

  async enableTwoFactor(
    auth: AuthContext,
    authKey: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    await this.verifyAuthKey(auth, authKey);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (user.twoFactorEnabled)
      throw new ConflictException("Two-factor authentication is already on");
    if (!user.twoFactorSecretEnc) throw new BadRequestException("Start setup first");
    const secret = serverDecrypt(user.twoFactorSecretEnc, `user:${user.id}:totp`);
    if (!(await this.acceptTotp(user.id, secret, code)))
      throw new BadRequestException("Invalid code");
    await this.prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
    const recoveryCodes = await this.newRecoveryCodes(user.id);
    await this.activity.securityEvent(auth, "two_factor_enabled", "info");
    return { recoveryCodes };
  }

  async disableTwoFactor(auth: AuthContext, authKey: string, code: string) {
    await this.verifyAuthKey(auth, authKey);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.twoFactorEnabled) throw new BadRequestException("Two-factor authentication is off");
    if (!(await this.checkSecondFactor(user, code, auth)))
      throw new BadRequestException("Invalid code");
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: false, twoFactorSecretEnc: null, lastTotpStep: null },
      }),
      this.prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    ]);
    await this.activity.securityEvent(auth, "two_factor_disabled", "critical");
  }

  async regenerateRecoveryCodes(
    auth: AuthContext,
    authKey: string,
  ): Promise<{ recoveryCodes: string[] }> {
    await this.verifyAuthKey(auth, authKey);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.twoFactorEnabled) throw new BadRequestException("Two-factor authentication is off");
    const recoveryCodes = await this.newRecoveryCodes(user.id);
    await this.activity.securityEvent(auth, "recovery_codes_regenerated", "warning");
    return { recoveryCodes };
  }

  async recoveryCodesLeft(auth: AuthContext): Promise<number> {
    return this.prisma.recoveryCode.count({ where: { userId: auth.userId, usedAt: null } });
  }

  /**
   * Master password change. The client re-wraps the same user key under the
   * new password, so no vault data has to be re-encrypted. Every other
   * session is revoked.
   */
  async changePassword(auth: AuthContext, dto: ChangePasswordDto) {
    await this.verifyAuthKey(auth, dto.currentAuthKey);
    await this.prisma.user.update({
      where: { id: auth.userId },
      data: {
        authHash: await hash(dto.newAuthKey, ARGON),
        kdfMemory: dto.kdf.memory,
        kdfIterations: dto.kdf.iterations,
        kdfParallelism: dto.kdf.parallelism,
        kdfSalt: dto.kdf.salt,
        protectedUserKey: dto.protectedUserKey,
      },
    });
    await this.sessions.revokeAll(auth, false);
    await this.activity.securityEvent(auth, "master_password_changed", "critical");
  }

  // ─── Backup codes (forgotten master password) ──────────────────────────────
  //
  // Made on the client, each code wraps the user key, so using one changes
  // only the master password: the vault, workspaces, shares and devices stay
  // as they were. The server keeps the SHA-256 of each code's proof, never
  // the code, and cannot open the wrapped key.

  async backupCodesStatus(auth: AuthContext) {
    const rows = await this.prisma.backupCode.findMany({
      where: { userId: auth.userId },
      select: { usedAt: true, createdAt: true },
    });
    return {
      total: rows.length,
      remaining: rows.filter((r) => !r.usedAt).length,
      createdAt: rows[0]?.createdAt.toISOString() ?? null,
    };
  }

  /** A new set replaces the old one, used or not. */
  async replaceBackupCodes(auth: AuthContext, dto: BackupCodesDto) {
    await this.verifyAuthKey(auth, dto.authKey);
    await this.prisma.$transaction([
      this.prisma.backupCode.deleteMany({ where: { userId: auth.userId } }),
      this.prisma.backupCode.createMany({
        data: dto.codes.map((c) => ({
          userId: auth.userId,
          proofHash: sha256(c.proof),
          protectedUserKey: c.protectedUserKey,
        })),
      }),
    ]);
    await this.activity.securityEvent(auth, "backup_codes_created", "warning", {
      count: dto.codes.length,
    });
  }

  /**
   * The codes are unguessable, so a wrong one does not count towards the
   * lockout: someone locked out by wrong passwords can still get back in.
   * Unknown email and wrong code answer the same.
   */
  private async backupCodeFor(email: string, proof: string) {
    const row = await this.prisma.backupCode.findUnique({
      where: { proofHash: sha256(proof) },
      include: { user: { include: { vaults: { orderBy: { createdAt: "asc" }, take: 1 } } } },
    });
    if (!row || row.usedAt || row.user.email !== this.normalizeEmail(email)) throw badBackupCode();
    return row;
  }

  /** What the client needs to open the user key before choosing a new master password. */
  async checkBackupCode(dto: RecoverCheckDto) {
    const { user, protectedUserKey } = await this.backupCodeFor(dto.email, dto.proof);
    return { userId: user.id, protectedUserKey, twoFactorRequired: user.twoFactorEnabled };
  }

  async recoverWithBackupCode(dto: RecoverCompleteDto, client: ClientInfo): Promise<AuthOutcome> {
    const row = await this.backupCodeFor(dto.email, dto.proof);
    const user = row.user;
    if (user.twoFactorEnabled) {
      this.assertNotLocked(user);
      const actor = { userId: user.id, ...client };
      if (!dto.code || !(await this.checkSecondFactor(user, dto.code, actor))) {
        await this.registerFailure(user.id, client, "2fa");
        throw new UnauthorizedException({ message: "Invalid code", code: "BAD_2FA_CODE" });
      }
    }
    const authHash = await hash(dto.authKey, ARGON);
    const fresh = await this.prisma.$transaction(async (tx) => {
      // One conditional UPDATE: a code works once, even if submitted twice at the same time.
      const used = await tx.backupCode.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (used.count !== 1) throw badBackupCode();
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date(), vaultUnlockedUntil: null },
      });
      return tx.user.update({
        where: { id: user.id },
        data: {
          authHash,
          kdfMemory: dto.kdf.memory,
          kdfIterations: dto.kdf.iterations,
          kdfParallelism: dto.kdf.parallelism,
          kdfSalt: dto.kdf.salt,
          protectedUserKey: dto.protectedUserKey,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
    });
    const device = await this.sessions.upsertDevice(user.id, dto.device, client);
    const { token, id } = await this.sessions.create(
      user.id,
      device.id,
      "ACTIVE",
      client,
      fresh.autoLockMinutes,
    );
    await this.markVisit(user.id);
    const remaining = await this.prisma.backupCode.count({
      where: { userId: user.id, usedAt: null },
    });
    const actor = { userId: user.id, deviceId: device.id, sessionId: id, ...client };
    await this.activity.log(actor, "auth.password_recovered");
    await this.activity.securityEvent(actor, "master_password_recovered", "critical", {
      count: remaining,
    });
    await this.mailer
      .send({
        to: user.email,
        subject: "Your Minions master password was changed",
        text: [
          "A backup code was used to set a new master password for your Minions account. Your vault was not changed, and every other device was signed out.",
          "",
          `You have ${remaining} unused backup code${remaining === 1 ? "" : "s"} left. Make a new set in Settings → Security when you run low.`,
          "",
          "If you did not do this, someone has one of your backup codes. Sign in, change your master password, and make new backup codes.",
        ].join("\n"),
      })
      .catch(() => undefined);
    return this.outcome(dto.device, token, {
      status: "ok",
      keys: this.keysFor(fresh, user.vaults[0]!),
    });
  }
}
