import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { loadConfig } from "../config";

/**
 * Server-side encryption for the few values the server itself must read
 * (the account TOTP secret). Vault data never goes through here; it is
 * encrypted on the client with keys the server does not have.
 */
export function serverEncrypt(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadConfig().serverEncryptionKey, iv);
  cipher.setAAD(Buffer.from(context));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `s1.${iv.toString("base64")}.${ct.toString("base64")}`;
}

export function serverDecrypt(envelope: string, context: string): string {
  const [version, ivB64, ctB64] = envelope.split(".");
  if (version !== "s1" || !ivB64 || !ctB64) throw new Error("Invalid server envelope");
  const data = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    loadConfig().serverEncryptionKey,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmac(key: Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
