import type { AuthResult } from "@minions/core";
import { Body, Controller, Get, HttpCode, Post, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import {
  AllowPending2fa,
  Auth,
  type AuthContext,
  Client,
  type ClientInfo,
  Public,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "../common/auth-context";
import { loadConfig } from "../config";
import {
  AuthKeyDto,
  ChangePasswordDto,
  DisableTwoFactorDto,
  EnableTwoFactorDto,
  LoginDto,
  PreloginDto,
  RegisterDto,
  TwoFactorVerifyDto,
} from "./auth.dto";
import { type AuthOutcome, AuthService } from "./auth.service";

const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: loadConfig().session.ttlDays * 86_400_000,
  });
}

function send(res: Response, outcome: AuthOutcome): AuthResult {
  if (!outcome.bearer) setSessionCookie(res, outcome.token);
  return outcome.result;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post("prelogin")
  @HttpCode(200)
  prelogin(@Body() dto: PreloginDto) {
    return this.auth.prelogin(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register")
  async register(
    @Body() dto: RegisterDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(res, await this.auth.register(dto, client));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post("login")
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(res, await this.auth.login(dto, client));
  }

  @AllowPending2fa()
  @Throttle(AUTH_THROTTLE)
  @Post("2fa/verify")
  @HttpCode(200)
  verify(@Auth() auth: AuthContext, @Body() dto: TwoFactorVerifyDto) {
    return this.auth.verifySecondFactor(auth, dto.code);
  }

  @AllowPending2fa()
  @Post("logout")
  @HttpCode(204)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(auth);
    res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
  }

  @Get("me")
  me(@Auth() auth: AuthContext) {
    return this.auth.me(auth);
  }

  @Throttle(AUTH_THROTTLE)
  @Post("2fa/setup")
  @HttpCode(200)
  setup(@Auth() auth: AuthContext) {
    return this.auth.setupTwoFactor(auth);
  }

  @Throttle(AUTH_THROTTLE)
  @Post("2fa/enable")
  @HttpCode(200)
  enable(@Auth() auth: AuthContext, @Body() dto: EnableTwoFactorDto) {
    return this.auth.enableTwoFactor(auth, dto.authKey, dto.code);
  }

  @Throttle(AUTH_THROTTLE)
  @Post("2fa/disable")
  @HttpCode(204)
  async disable(@Auth() auth: AuthContext, @Body() dto: DisableTwoFactorDto) {
    await this.auth.disableTwoFactor(auth, dto.authKey, dto.code);
  }

  @Throttle(AUTH_THROTTLE)
  @Post("2fa/recovery-codes")
  @HttpCode(200)
  recoveryCodes(@Auth() auth: AuthContext, @Body() dto: AuthKeyDto) {
    return this.auth.regenerateRecoveryCodes(auth, dto.authKey);
  }

  @Get("2fa/recovery-codes/remaining")
  async remaining(@Auth() auth: AuthContext) {
    return { remaining: await this.auth.recoveryCodesLeft(auth) };
  }

  @Throttle(AUTH_THROTTLE)
  @Post("change-password")
  @HttpCode(204)
  async changePassword(@Auth() auth: AuthContext, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(auth, dto);
  }
}
