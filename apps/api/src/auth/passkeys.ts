import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { IsBase64, IsObject, IsOptional, IsString, Length } from "class-validator";
import { ActivityService } from "../activity/activity.service";
import { AllowPending2fa, Auth, type AuthContext } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import { loadConfig } from "../config";
import { AuthService } from "./auth.service";

const CHALLENGE_TTL_MS = 5 * 60_000;

class RegisterOptionsDto {
  /** Adding a sign-in factor needs the master password, not just a session. */
  @IsBase64() @Length(44, 44) authKey!: string;
}
class RegisterVerifyDto {
  @IsObject() response!: RegistrationResponseJSON;
  @IsOptional() @IsString() @Length(1, 60) name?: string;
}
class AuthVerifyDto {
  @IsObject() response!: AuthenticationResponseJSON;
}
class RemoveDto {
  @IsBase64() @Length(44, 44) authKey!: string;
}

/**
 * Passkeys (WebAuthn) as a second factor. They replace the 6-digit code at
 * sign-in; the vault still opens with the master password, which is what its
 * encryption key is derived from.
 */
@Injectable()
export class PasskeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly activity: ActivityService,
  ) {}

  private rp() {
    const cfg = loadConfig();
    return { rpID: cfg.webauthn.rpId, origins: cfg.webauthn.origins };
  }

  private async setChallenge(sessionId: string, challenge: string) {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        webauthnChallenge: challenge,
        webauthnChallengeExpiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });
  }

  /**
   * Each challenge is single-use. It is cleared with a conditional UPDATE on
   * the value just read, so two requests racing with one challenge cannot
   * both get it.
   */
  private async takeChallenge(sessionId: string): Promise<string> {
    const s = await this.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    const challenge = s.webauthnChallenge;
    const taken = challenge
      ? await this.prisma.session.updateMany({
          where: { id: sessionId, webauthnChallenge: challenge },
          data: { webauthnChallenge: null, webauthnChallengeExpiresAt: null },
        })
      : { count: 0 };
    if (
      !challenge ||
      taken.count !== 1 ||
      !s.webauthnChallengeExpiresAt ||
      s.webauthnChallengeExpiresAt < new Date()
    ) {
      throw new BadRequestException("The passkey request expired. Try again.");
    }
    return challenge;
  }

  async list(ctx: AuthContext) {
    const rows = await this.prisma.webauthnCredential.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }));
  }

  async registrationOptions(ctx: AuthContext, authKey: string) {
    await this.auth.verifyAuthKey(ctx, authKey);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      include: { webauthnCredentials: true },
    });
    const { rpID } = this.rp();
    const options = await generateRegistrationOptions({
      rpName: "Minions",
      rpID,
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: user.webauthnCredentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    await this.setChallenge(ctx.sessionId, options.challenge);
    return options;
  }

  async register(ctx: AuthContext, dto: RegisterVerifyDto) {
    const expectedChallenge = await this.takeChallenge(ctx.sessionId);
    const { rpID, origins } = this.rp();
    const result = await verifyRegistrationResponse({
      response: dto.response,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: false,
    }).catch(() => null);
    if (!result?.verified || !result.registrationInfo)
      throw new BadRequestException("Passkey could not be verified");
    const { credential } = result.registrationInfo;
    const row = await this.prisma.webauthnCredential.create({
      data: {
        userId: ctx.userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64"),
        counter: BigInt(credential.counter),
        transports: credential.transports ?? [],
        name: dto.name?.trim() || "Passkey",
      },
    });
    await this.activity.securityEvent(ctx, "two_factor_enabled", "info", { kind: "passkey" });
    return { id: row.id, name: row.name, createdAt: row.createdAt, lastUsedAt: null };
  }

  async remove(ctx: AuthContext, id: string, authKey: string) {
    await this.auth.verifyAuthKey(ctx, authKey);
    const result = await this.prisma.webauthnCredential.deleteMany({
      where: { id, userId: ctx.userId },
    });
    if (!result.count) throw new NotFoundException();
    await this.activity.securityEvent(ctx, "two_factor_disabled", "warning", { kind: "passkey" });
  }

  /** Second step of sign-in, for a session waiting on 2FA. */
  async loginOptions(ctx: AuthContext) {
    const session = await this.prisma.session.findUniqueOrThrow({ where: { id: ctx.sessionId } });
    if (session.state !== "PENDING_2FA")
      throw new BadRequestException("Session does not need verification");
    await this.auth.assertPendingAllowed(ctx);
    const creds = await this.prisma.webauthnCredential.findMany({ where: { userId: ctx.userId } });
    if (!creds.length) throw new BadRequestException("No passkeys on this account");
    const options = await generateAuthenticationOptions({
      rpID: this.rp().rpID,
      allowCredentials: creds.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      userVerification: "preferred",
    });
    await this.setChallenge(ctx.sessionId, options.challenge);
    return options;
  }

  async login(ctx: AuthContext, response: AuthenticationResponseJSON) {
    await this.auth.assertPendingAllowed(ctx);
    const expectedChallenge = await this.takeChallenge(ctx.sessionId);
    const cred = await this.prisma.webauthnCredential.findFirst({
      where: { userId: ctx.userId, credentialId: response.id },
    });
    if (!cred) return this.auth.secondFactorFailed(ctx, "passkey");
    const { rpID, origins } = this.rp();
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64")),
        counter: Number(cred.counter),
        transports: cred.transports as AuthenticatorTransportFuture[],
      },
    }).catch(() => null);
    if (!result?.verified) return this.auth.secondFactorFailed(ctx, "passkey");
    await this.prisma.webauthnCredential.update({
      where: { id: cred.id },
      data: { counter: BigInt(result.authenticationInfo.newCounter), lastUsedAt: new Date() },
    });
    return this.auth.completeSecondFactor(ctx, "passkey");
  }
}

@Controller("auth/passkeys")
export class PasskeyController {
  constructor(private readonly passkeys: PasskeyService) {}

  @Get() list(@Auth() a: AuthContext) {
    return this.passkeys.list(a);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("register/options")
  @HttpCode(200)
  registerOptions(@Auth() a: AuthContext, @Body() dto: RegisterOptionsDto) {
    return this.passkeys.registrationOptions(a, dto.authKey);
  }

  @Post("register")
  register(@Auth() a: AuthContext, @Body() dto: RegisterVerifyDto) {
    return this.passkeys.register(a, dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(":id/remove")
  @HttpCode(204)
  async remove(
    @Auth() a: AuthContext,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() dto: RemoveDto,
  ) {
    await this.passkeys.remove(a, id, dto.authKey);
  }

  @AllowPending2fa()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("login/options")
  @HttpCode(200)
  loginOptions(@Auth() a: AuthContext) {
    return this.passkeys.loginOptions(a);
  }

  @AllowPending2fa()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("login")
  @HttpCode(200)
  login(@Auth() a: AuthContext, @Body() dto: AuthVerifyDto) {
    return this.passkeys.login(a, dto.response);
  }
}
