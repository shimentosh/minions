import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Request } from "express";

export interface AuthContext {
  userId: string;
  vaultId: string;
  sessionId: string;
  deviceId: string | null;
  vaultUnlockedUntil: Date | null;
  bearer: boolean;
  ip: string | null;
  userAgent: string | null;
  /**
   * Set only on the scoped context the workspace module builds after it has
   * authorised the caller; `vaultId` is then the workspace's vault. Activity
   * logged with it lands in that workspace's audit log.
   */
  workspaceId?: string;
}

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

export const IS_PUBLIC = "minions:public";
export const ALLOW_PENDING_2FA = "minions:allowPending2fa";

/** No session required (register, prelogin, login). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Reachable with a session that has passed the password but not yet 2FA. */
export const AllowPending2fa = () => SetMetadata(ALLOW_PENDING_2FA, true);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new Error("Auth context missing: route is not behind SessionGuard");
  return req.auth;
});

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export const Client = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientInfo => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { ip: req.ip ?? null, userAgent: req.get("user-agent")?.slice(0, 300) ?? null };
});

const PRODUCTION = process.env.NODE_ENV === "production";

/**
 * In production the cookie carries the `__Host-` prefix: browsers then only
 * accept it when it is Secure, has Path=/ and no Domain, so a sibling
 * subdomain cannot plant or overwrite a session cookie.
 */
export const SESSION_COOKIE = PRODUCTION ? "__Host-minions_session" : "minions_session";

/** The same attributes must be used to set and to clear the cookie. */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: PRODUCTION,
  sameSite: "strict",
  path: "/",
} as const;
export const CLIENT_HEADER = "x-minions-client";
