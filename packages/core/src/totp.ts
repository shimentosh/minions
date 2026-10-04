import { base32Decode } from "./encoding";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpConfig {
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  issuer?: string;
  account?: string;
}

/** Accepts a bare base32 secret or an otpauth://totp/ URI. */
export function parseTotp(input: string): TotpConfig {
  const value = input.trim();
  if (value.toLowerCase().startsWith("otpauth://")) {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "totp") throw new Error("Only TOTP URIs are supported");
    const secret = url.searchParams.get("secret");
    if (!secret) throw new Error("URI has no secret");
    const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const [labelIssuer, account] = label.includes(":") ? label.split(":", 2) : [undefined, label];
    const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase() as TotpAlgorithm;
    if (!["SHA1", "SHA256", "SHA512"].includes(algorithm)) throw new Error("Unsupported algorithm");
    const digits = Number(url.searchParams.get("digits") ?? 6);
    const period = Number(url.searchParams.get("period") ?? 30);
    if (![6, 7, 8].includes(digits) || !(period >= 10 && period <= 300)) {
      throw new Error("Unsupported TOTP parameters");
    }
    base32Decode(secret);
    return {
      secret: secret.replace(/\s/g, "").toUpperCase(),
      algorithm,
      digits,
      period,
      issuer: url.searchParams.get("issuer") ?? labelIssuer?.trim(),
      account: account?.trim() || undefined,
    };
  }
  const secret = value.replace(/[\s-]/g, "").toUpperCase();
  if (secret.length < 16) throw new Error("TOTP secret is too short");
  base32Decode(secret);
  return { secret, algorithm: "SHA1", digits: 6, period: 30 };
}

export function isValidTotp(input: string): boolean {
  try {
    parseTotp(input);
    return true;
  } catch {
    return false;
  }
}

async function hotp(
  key: Uint8Array<ArrayBuffer>,
  counter: number,
  algorithm: TotpAlgorithm,
  digits: number,
): Promise<string> {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const hash = algorithm === "SHA1" ? "SHA-1" : algorithm === "SHA256" ? "SHA-256" : "SHA-512";
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", cryptoKey, buf));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export interface TotpCode {
  code: string;
  /** Seconds until this code expires. */
  remaining: number;
  period: number;
}

export async function generateTotp(
  input: string | TotpConfig,
  now = Date.now(),
): Promise<TotpCode> {
  const config = typeof input === "string" ? parseTotp(input) : input;
  const seconds = Math.floor(now / 1000);
  const counter = Math.floor(seconds / config.period);
  const code = await hotp(base32Decode(config.secret), counter, config.algorithm, config.digits);
  return { code, remaining: config.period - (seconds % config.period), period: config.period };
}

/** Checks a code within ±window steps. Returns the matched counter, or null. */
export async function verifyTotp(
  secret: string,
  code: string,
  now = Date.now(),
  window = 1,
): Promise<number | null> {
  const config = parseTotp(secret);
  const clean = code.replace(/\s/g, "");
  if (!/^\d+$/.test(clean) || clean.length !== config.digits) return null;
  const counter = Math.floor(now / 1000 / config.period);
  const key = base32Decode(config.secret);
  for (let offset = -window; offset <= window; offset++) {
    const candidate = await hotp(key, counter + offset, config.algorithm, config.digits);
    if (timingSafeEqual(candidate, clean)) return counter + offset;
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function totpUri(secret: string, account: string, issuer = "Minions"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
