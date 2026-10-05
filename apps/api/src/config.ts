import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function key32(name: string): Buffer {
  const buf = Buffer.from(required(name), "base64");
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded`);
  return buf;
}

/** An optional http URL that must point at this machine, so mail can't be sent anywhere else. */
function loopbackUrl(name: string): string | null {
  const value = process.env[name];
  if (!value) return null;
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(value))
    throw new Error(`${name} must be http://localhost:<port> or http://127.0.0.1:<port>`);
  return value.replace(/\/$/, "");
}

/**
 * TRUST_PROXY: a hop count ("2") or Express subnet names/CIDRs
 * ("loopback, uniquelocal"). Never "true": then any client could pick its own
 * IP with X-Forwarded-For and dodge the rate limits.
 */
function trustProxySetting(): string | number {
  const value = process.env.TRUST_PROXY?.trim() || "loopback";
  if (/^\d+$/.test(value)) return Number(value);
  if (/^(true|\*)$/i.test(value))
    throw new Error(
      "TRUST_PROXY must name the proxies (e.g. loopback, uniquelocal), not trust all",
    );
  return value;
}

export interface AppConfig {
  env: "development" | "production" | "test";
  port: number;
  /**
   * Express "trust proxy": which hops may set X-Forwarded-For, so `req.ip` is
   * the client and not the reverse proxy. Rate limits, sessions and the
   * activity log key on it. Behind Traefik and nginx in Docker: private ranges.
   */
  trustProxy: string | number;
  databaseUrl: string;
  webOrigins: string[];
  extensionOrigins: string[];
  serverEncryptionKey: Buffer;
  preloginSecret: Buffer;
  deepseek: { apiKey: string | null; baseUrl: string; model: string };
  session: { ttlDays: number; pending2faMinutes: number };
  /** WebAuthn relying party: the web app's host, and the origins passkeys may be used from. */
  webauthn: { rpId: string; origins: string[] };
  /**
   * Account ids allowed to open the operator dashboard. Ids, not emails: email
   * ownership is never verified, so anyone could register an allowlisted
   * address that has no account yet. Empty = nobody.
   */
  operatorUserIds: string[];
  /**
   * Outgoing mail (email verification). `publicWebUrl` is where links in emails point.
   * `mailpitUrl` is a local Mailpit for development; production refuses to start with it.
   */
  mail: {
    resendApiKey: string | null;
    mailpitUrl: string | null;
    from: string;
    publicWebUrl: string;
  };
}

let cached: AppConfig | null = null;

/**
 * Refuses to start a production server with development defaults: shared
 * dev credentials, plain-http origins, or one key reused for two purposes.
 */
function assertProductionSafe(cfg: AppConfig) {
  const problems: string[] = [];
  if (/minions_dev_only/.test(cfg.databaseUrl))
    problems.push("DATABASE_URL uses the development password");
  if (cfg.serverEncryptionKey.equals(cfg.preloginSecret))
    problems.push("SERVER_ENCRYPTION_KEY and PRELOGIN_SECRET must be different keys");
  if (cfg.webOrigins.length === 0) problems.push("WEB_ORIGINS is empty");
  for (const o of [...cfg.webOrigins, ...cfg.webauthn.origins])
    if (/^http:\/\//.test(o) && !/^http:\/\/(tauri\.)?localhost(:\d+)?$/.test(o))
      problems.push(`Origin ${o} is not https`);
  for (const o of cfg.extensionOrigins)
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(o))
      problems.push(`Extension origin ${o} is invalid`);
  if (cfg.webauthn.rpId === "localhost") problems.push("WEBAUTHN_RP_ID is localhost");
  if (!cfg.mail.resendApiKey)
    problems.push("RESEND_API_KEY is not set (email verification cannot work)");
  if (process.env.MAILPIT_URL) problems.push("MAILPIT_URL is for development only");
  if (/@localhost>?$/.test(cfg.mail.from)) problems.push("MAIL_FROM is not a real sender address");
  if (!cfg.mail.publicWebUrl.startsWith("https://")) problems.push("PUBLIC_WEB_URL is not https");
  if (problems.length)
    throw new Error(`Unsafe production configuration:\n - ${problems.join("\n - ")}`);
}

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const env = (process.env.NODE_ENV ?? "development") as AppConfig["env"];
  cached = {
    env,
    port: Number(process.env.PORT ?? 4000),
    trustProxy: trustProxySetting(),
    databaseUrl: env === "test" ? required("TEST_DATABASE_URL") : required("DATABASE_URL"),
    webOrigins: (process.env.WEB_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    extensionOrigins: (process.env.EXTENSION_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    serverEncryptionKey: key32("SERVER_ENCRYPTION_KEY"),
    preloginSecret: key32("PRELOGIN_SECRET"),
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || null,
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    },
    session: { ttlDays: 30, pending2faMinutes: 10 },
    webauthn: {
      rpId: process.env.WEBAUTHN_RP_ID || "localhost",
      origins: (process.env.WEBAUTHN_ORIGINS || process.env.WEB_ORIGINS || "http://localhost:5180")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("http")),
    },
    operatorUserIds: (process.env.OPERATOR_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)),
    mail: {
      resendApiKey: process.env.RESEND_API_KEY || null,
      mailpitUrl: loopbackUrl("MAILPIT_URL"),
      from: process.env.MAIL_FROM || "Minions <no-reply@localhost>",
      publicWebUrl: (
        process.env.PUBLIC_WEB_URL ||
        (process.env.WEB_ORIGINS ?? "").split(",")[0]?.trim() ||
        "http://localhost:5180"
      ).replace(/\/$/, ""),
    },
  };
  if (env === "production") assertProductionSafe(cached);
  return cached;
}

/** For tests that change env between runs. */
export function resetConfig(): void {
  cached = null;
}

export const CONFIG = Symbol("CONFIG");
