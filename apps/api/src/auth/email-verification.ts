import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Injectable,
  Module,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Matches } from "class-validator";
import { ActivityService } from "../activity/activity.service";
import { Auth, type AuthContext, Client, type ClientInfo, Public } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import { newToken, sha256 } from "../common/server-crypto";
import { loadConfig } from "../config";
import { Mailer } from "../mail/mailer";

const TOKEN_TTL_MS = 24 * 60 * 60_000;

class VerifyDto {
  /** 32 random bytes, base64url. Only its SHA-256 is stored. */
  @Matches(/^[A-Za-z0-9_-]{43}$/) token!: string;
}

/**
 * Proves the person controls the address they signed up with. Until then the
 * address is a claim: anything that grants access by email (workspace
 * invitations) requires it to be verified.
 *
 * The link carries the token in the URL fragment, which browsers never send
 * to a server, so it stays out of web-server and proxy logs; the page posts
 * it here.
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    private readonly activity: ActivityService,
  ) {}

  /** Sends a fresh link. Earlier unused links stop working. */
  async send(userId: string): Promise<{ sent: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (user.emailVerifiedAt) return { sent: false };
    const token = newToken();
    await this.prisma.$transaction([
      this.prisma.emailVerification.deleteMany({ where: { userId, usedAt: null } }),
      this.prisma.emailVerification.create({
        data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
      }),
    ]);
    const link = `${loadConfig().mail.publicWebUrl}/verify-email#${token}`;
    const sent = await this.mailer.send({
      to: user.email,
      subject: "Confirm your email for Minions",
      text: [
        "Open this link to confirm that this address is yours:",
        "",
        link,
        "",
        "It works once and expires in 24 hours. If you did not create a Minions account, ignore this email.",
        "Minions will never ask for your master password by email.",
      ].join("\n"),
    });
    return { sent };
  }

  async verify(token: string, client: ClientInfo): Promise<void> {
    const hash = sha256(token);
    const row = await this.prisma.emailVerification.findUnique({ where: { tokenHash: hash } });
    // One conditional UPDATE: a link works once, even if opened twice at the same time.
    const used = await this.prisma.emailVerification.updateMany({
      where: { tokenHash: hash, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (!row || used.count !== 1)
      throw new BadRequestException({
        message: "This link is invalid or has expired. Request a new one.",
        code: "BAD_VERIFICATION_LINK",
      });
    await this.prisma.user.updateMany({
      where: { id: row.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    await this.activity.securityEvent({ userId: row.userId, ...client }, "email_verified", "info");
  }
}

@Controller("auth/email")
export class EmailVerificationController {
  constructor(private readonly verification: EmailVerificationService) {}

  @Throttle({ default: { limit: 3, ttl: 10 * 60_000 } })
  @Post("verify-request")
  @HttpCode(200)
  request(@Auth() auth: AuthContext) {
    return this.verification.send(auth.userId);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("verify")
  @HttpCode(204)
  async verify(@Body() dto: VerifyDto, @Client() client: ClientInfo) {
    await this.verification.verify(dto.token, client);
  }
}

@Module({
  controllers: [EmailVerificationController],
  providers: [EmailVerificationService],
  exports: [EmailVerificationService],
})
export class EmailVerificationModule {}
