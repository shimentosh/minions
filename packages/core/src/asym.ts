import { DecryptionError, decryptBytes, encryptBytes } from "./crypto";
import { fromBase64, toBase64, toHex, utf8 } from "./encoding";

/**
 * Public-key cryptography for sharing inside a workspace. See ARCHITECTURE.md §7.
 *
 * Each user has an RSA-OAEP-3072 (SHA-256) key pair. The public key is stored
 * in the clear; the private key is stored wrapped by the user key, so only
 * the user's own master password opens it. A key (workspace key, item key)
 * is "sealed" to a member by encrypting it to their public key, with an OAEP
 * label naming what it is and who it is for, so the server cannot move a
 * sealed key to another item or member.
 *
 * RSA-OAEP is used rather than X25519 because every WebCrypto we ship to
 * (Chrome extension, WebView2, Safari, Firefox, Node) has supported it for years.
 */

export const SEALED_VERSION = "r1";
const MODULUS_BITS = 3072;
const SEALED_BYTES = MODULUS_BITS / 8;
const KEY_BYTES = 32;

const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: "RSA-OAEP",
  modulusLength: MODULUS_BITS,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available in this environment");
  return s;
}

export const sealContext = {
  /** The workspace key, sealed to one member. */
  workspaceKey: (workspaceId: string, userId: string) => `workspace:${workspaceId}:key:${userId}`,
  /** One item's key, sealed to one member. */
  itemKey: (itemId: string, userId: string) => `item:${itemId}:key:${userId}`,
};

export const keyAad = {
  /** The user's private key, wrapped by their user key. */
  privateKey: (userId: string) => `user:${userId}:private-key`,
  /** An item's key wrapped by its workspace key ("everyone in the workspace"). */
  itemKeyForWorkspace: (workspaceId: string, itemId: string) =>
    `workspace:${workspaceId}:item:${itemId}:key`,
};

export interface UserKeyPair {
  /** Base64 SPKI. Safe to publish. */
  publicKey: string;
  /** PKCS#8 bytes. Wrap before it leaves memory. */
  privateKey: Uint8Array<ArrayBuffer>;
}

export async function generateUserKeyPair(): Promise<UserKeyPair> {
  const pair = (await subtle().generateKey(RSA_PARAMS, true, [
    "encrypt",
    "decrypt",
  ])) as CryptoKeyPair;
  const [spki, pkcs8] = await Promise.all([
    subtle().exportKey("spki", pair.publicKey),
    subtle().exportKey("pkcs8", pair.privateKey),
  ]);
  return { publicKey: toBase64(new Uint8Array(spki)), privateKey: new Uint8Array(pkcs8) };
}

export async function protectPrivateKey(
  userKey: Uint8Array<ArrayBuffer>,
  privateKey: Uint8Array<ArrayBuffer>,
  userId: string,
): Promise<string> {
  return encryptBytes(userKey, privateKey, keyAad.privateKey(userId));
}

/**
 * Unwraps the private key and imports it as a non-extractable CryptoKey, so
 * page script can use it but never read it back out.
 */
export async function openPrivateKey(
  userKey: Uint8Array<ArrayBuffer>,
  protectedPrivateKey: string,
  userId: string,
): Promise<CryptoKey> {
  const pkcs8 = await decryptBytes(userKey, protectedPrivateKey, keyAad.privateKey(userId));
  try {
    return await importPrivateKey(pkcs8, false);
  } finally {
    pkcs8.fill(0);
  }
}

/** The extension keeps the PKCS#8 bytes in memory-only session storage and imports per use. */
export async function unwrapPrivateKeyBytes(
  userKey: Uint8Array<ArrayBuffer>,
  protectedPrivateKey: string,
  userId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return decryptBytes(userKey, protectedPrivateKey, keyAad.privateKey(userId));
}

export async function importPrivateKey(
  pkcs8: Uint8Array<ArrayBuffer>,
  extractable = false,
): Promise<CryptoKey> {
  try {
    return await subtle().importKey("pkcs8", pkcs8, RSA_PARAMS, extractable, ["decrypt"]);
  } catch {
    throw new DecryptionError();
  }
}

async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return subtle().importKey("spki", fromBase64(publicKey), RSA_PARAMS, false, ["encrypt"]);
}

/** Encrypts a 256-bit key to someone's public key. */
export async function sealKey(
  publicKey: string,
  key: Uint8Array<ArrayBuffer>,
  context: string,
): Promise<string> {
  if (key.length !== KEY_BYTES) throw new Error("Invalid key length");
  const ct = await subtle().encrypt(
    { name: "RSA-OAEP", label: utf8(context) },
    await importPublicKey(publicKey),
    key,
  );
  return `${SEALED_VERSION}.${toBase64(new Uint8Array(ct))}`;
}

export async function openSealedKey(
  privateKey: CryptoKey,
  sealed: string,
  context: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!isSealedKey(sealed)) throw new DecryptionError();
  try {
    const pt = await subtle().decrypt(
      { name: "RSA-OAEP", label: utf8(context) },
      privateKey,
      fromBase64(sealed.slice(SEALED_VERSION.length + 1)),
    );
    const key = new Uint8Array(pt);
    if (key.length !== KEY_BYTES) throw new DecryptionError();
    return key;
  } catch {
    // Wrong key, wrong label and tampering look the same.
    throw new DecryptionError();
  }
}

/** Shape check only: `r1.` + base64 of one 3072-bit RSA block. */
export function isSealedKey(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(`${SEALED_VERSION}.`)) return false;
  const b64 = value.slice(SEALED_VERSION.length + 1);
  return b64.length === Math.ceil(SEALED_BYTES / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(b64);
}

/**
 * A short, human-comparable fingerprint of a public key: the first 20 bytes
 * of its SHA-256, as five groups of eight hex digits. Two people reading it
 * to each other confirm the server did not substitute a key.
 */
export async function publicKeyFingerprint(publicKey: string): Promise<string> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", fromBase64(publicKey)));
  const hex = toHex(digest.subarray(0, 20));
  return hex.match(/.{8}/g)!.join(" ");
}
