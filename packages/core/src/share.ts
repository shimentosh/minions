import { argon2id } from "hash-wasm";
import { decryptString, encryptString, hkdf, randomBytes } from "./crypto";
import { fromBase64, toBase64, toHex } from "./encoding";

/**
 * Share links. The link key travels only in the URL's #fragment, which
 * browsers never send to a server, so the server stores ciphertext it cannot
 * open. An optional passphrase adds a second key the server never sees
 * either; the server only gets a hash of a token derived from it, to refuse
 * wrong guesses before handing out the ciphertext.
 */

export interface SharePayload {
  v: 1;
  name: string;
  type: string;
  fields: { label: string; value: string; kind?: string; sensitive: boolean }[];
  /** TOTP secret, when the sender chose to include live 2FA codes. */
  totp?: string;
  message?: string;
  sharedBy?: string;
}

export const SHARE_KDF = { memory: 19456, iterations: 2, parallelism: 1 } as const;

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export function newShareLinkKey(): Uint8Array<ArrayBuffer> {
  return randomBytes(32);
}

export interface ShareKeys {
  encKey: Uint8Array<ArrayBuffer>;
  /** Sent to the server to prove the passphrase; null without one. */
  accessToken: string | null;
}

export async function deriveShareKeys(
  linkKey: Uint8Array<ArrayBuffer>,
  passphrase?: { value: string; salt: string },
): Promise<ShareKeys> {
  if (!passphrase) return { encKey: await hkdf(linkKey, "minions/share/enc"), accessToken: null };
  const passKey = new Uint8Array(
    await argon2id({
      password: passphrase.value.normalize("NFKC"),
      salt: fromBase64(passphrase.salt),
      ...SHARE_KDF,
      memorySize: SHARE_KDF.memory,
      hashLength: 32,
      outputType: "binary",
    }),
  );
  const both = new Uint8Array(64);
  both.set(linkKey, 0);
  both.set(passKey, 32);
  const [encKey, access] = await Promise.all([
    hkdf(both, "minions/share/enc+pass"),
    hkdf(passKey, "minions/share/access"),
  ]);
  both.fill(0);
  passKey.fill(0);
  return { encKey, accessToken: toHex(access) };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

export const shareAad = (shareId: string) => `share:${shareId}`;

export async function encryptSharePayload(
  encKey: Uint8Array<ArrayBuffer>,
  shareId: string,
  payload: SharePayload,
): Promise<string> {
  return encryptString(encKey, JSON.stringify(payload), shareAad(shareId));
}

export async function decryptSharePayload(
  encKey: Uint8Array<ArrayBuffer>,
  shareId: string,
  envelope: string,
): Promise<SharePayload> {
  return JSON.parse(await decryptString(encKey, envelope, shareAad(shareId))) as SharePayload;
}

export interface CreateShareRequest {
  id: string;
  itemId?: string | null;
  label: string;
  ciphertext: string;
  expiresInMinutes: number;
  maxViews: number | null;
  includesTotp: boolean;
  passphraseSalt?: string;
  /** SHA-256 of the passphrase-derived access token. */
  accessHash?: string;
}

export interface ShareMeta {
  id: string;
  expiresAt: string;
  viewsLeft: number | null;
  requiresPassphrase: boolean;
  passphraseSalt: string | null;
  available: boolean;
  reason?: "expired" | "used" | "revoked";
}

export interface ShareSummary {
  id: string;
  itemId: string | null;
  label: string;
  expiresAt: string;
  maxViews: number | null;
  viewCount: number;
  includesTotp: boolean;
  requiresPassphrase: boolean;
  status: "active" | "expired" | "used" | "revoked";
  createdAt: string;
  lastViewedAt: string | null;
}
