import { argon2id } from "hash-wasm";
import { fromBase64, fromUtf8, toBase64, toHex, utf8 } from "./encoding";

/**
 * Client-side vault cryptography. See ARCHITECTURE.md §1.
 *
 * Keys are passed around as raw bytes because they have to be wrapped
 * (encrypted under another key) and, in the extension, handed between
 * contexts. They are imported into WebCrypto only at the moment of use.
 */

export const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface KdfParams {
  type: "argon2id";
  /** Memory in KiB. */
  memory: number;
  iterations: number;
  parallelism: number;
  /** Base64, 16 bytes. */
  salt: string;
}

/** OWASP 2024+ guidance for Argon2id is at least m=19MiB,t=2. We use more. */
export const DEFAULT_KDF: Omit<KdfParams, "salt"> = {
  type: "argon2id",
  memory: 65536,
  iterations: 3,
  parallelism: 1,
};

/** Lower bounds the server enforces, so a client cannot register weak params. */
export const MIN_KDF = { memory: 19456, iterations: 2, parallelism: 1 } as const;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available in this environment");
  return s;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function generateKey(): Uint8Array<ArrayBuffer> {
  return randomBytes(KEY_BYTES);
}

export function newKdfParams(): KdfParams {
  return { ...DEFAULT_KDF, salt: toBase64(randomBytes(16)) };
}

export async function deriveMasterKey(
  password: string,
  params: KdfParams,
): Promise<Uint8Array<ArrayBuffer>> {
  if (params.type !== "argon2id") throw new Error("Unsupported KDF");
  const out = await argon2id({
    password: password.normalize("NFKC"),
    salt: fromBase64(params.salt),
    iterations: params.iterations,
    memorySize: params.memory,
    parallelism: params.parallelism,
    hashLength: KEY_BYTES,
    outputType: "binary",
  });
  return new Uint8Array(out);
}

export async function hkdf(
  keyMaterial: Uint8Array<ArrayBuffer>,
  info: string,
  length = KEY_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  const base = await subtle().importKey("raw", keyMaterial, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8(info) },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

export interface MasterKeys {
  /** Sent to the server as proof of the master password. Never an encryption key. */
  authKey: string;
  /** Unwraps the user key. Never leaves the client. */
  stretchedKey: Uint8Array<ArrayBuffer>;
}

export async function deriveMasterKeys(password: string, params: KdfParams): Promise<MasterKeys> {
  const master = await deriveMasterKey(password, params);
  try {
    const [auth, stretched] = await Promise.all([
      hkdf(master, "minions/auth"),
      hkdf(master, "minions/enc"),
    ]);
    return { authKey: toBase64(auth), stretchedKey: stretched };
  } finally {
    master.fill(0);
  }
}

async function aesKey(raw: Uint8Array<ArrayBuffer>, usage: KeyUsage[]): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) throw new Error("Invalid key length");
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, usage);
}

export function isEnvelope(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) return false;
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  // 12-byte IV is 16 base64 chars; ciphertext holds at least the 16-byte tag.
  return (
    parts[1]!.length === 16 && b64.test(parts[1]!) && parts[2]!.length >= 24 && b64.test(parts[2]!)
  );
}

export async function encryptBytes(
  key: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
  aad: string,
): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(aad), tagLength: 128 },
    await aesKey(key, ["encrypt"]),
    plaintext,
  );
  return `${ENVELOPE_VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

export class DecryptionError extends Error {
  constructor() {
    super("Decryption failed");
    this.name = "DecryptionError";
  }
}

export async function decryptBytes(
  key: Uint8Array<ArrayBuffer>,
  envelope: string,
  aad: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!isEnvelope(envelope)) throw new DecryptionError();
  const [, ivB64, ctB64] = envelope.split(".");
  try {
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: fromBase64(ivB64!), additionalData: utf8(aad), tagLength: 128 },
      await aesKey(key, ["decrypt"]),
      fromBase64(ctB64!),
    );
    return new Uint8Array(pt);
  } catch {
    // Wrong key, wrong AAD and tampering are deliberately indistinguishable.
    throw new DecryptionError();
  }
}

export async function encryptString(
  key: Uint8Array<ArrayBuffer>,
  plaintext: string,
  aad: string,
): Promise<string> {
  return encryptBytes(key, utf8(plaintext), aad);
}

export async function decryptString(
  key: Uint8Array<ArrayBuffer>,
  envelope: string,
  aad: string,
): Promise<string> {
  return fromUtf8(await decryptBytes(key, envelope, aad));
}

export const aad = {
  userKey: (userId: string) => `user:${userId}:key`,
  vaultKey: (vaultId: string) => `vault:${vaultId}:key`,
  field: (itemId: string, fieldKey: string) => `item:${itemId}:field:${fieldKey}`,
  note: (noteId: string) => `note:${noteId}:content`,
  version: (itemId: string, fieldKey: string) => `item:${itemId}:field:${fieldKey}`,
};

export async function wrapKey(
  wrappingKey: Uint8Array<ArrayBuffer>,
  key: Uint8Array<ArrayBuffer>,
  context: string,
): Promise<string> {
  return encryptBytes(wrappingKey, key, context);
}

export async function unwrapKey(
  wrappingKey: Uint8Array<ArrayBuffer>,
  envelope: string,
  context: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await decryptBytes(wrappingKey, envelope, context);
  if (key.length !== KEY_BYTES) throw new DecryptionError();
  return key;
}

/**
 * Keyed fingerprint of a secret, for reuse detection. The server learns only
 * that two of this user's items share a value, never the value itself, and
 * cannot brute-force it without the vault key.
 */
export async function secretFingerprint(
  vaultKey: Uint8Array<ArrayBuffer>,
  secret: string,
): Promise<string> {
  const fpKey = await hkdf(vaultKey, "minions/fingerprint");
  const key = await subtle().importKey("raw", fpKey, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await subtle().sign("HMAC", key, utf8(secret));
  fpKey.fill(0);
  return toHex(new Uint8Array(sig));
}

export interface RegistrationKeys {
  kdf: KdfParams;
  authKey: string;
  protectedUserKey: string;
  protectedVaultKey: string;
  userKey: Uint8Array<ArrayBuffer>;
  vaultKey: Uint8Array<ArrayBuffer>;
}

/** Everything a client needs to create an account, computed locally. */
export async function createAccountKeys(
  password: string,
  userId: string,
  vaultId: string,
  kdf: KdfParams = newKdfParams(),
): Promise<RegistrationKeys> {
  const { authKey, stretchedKey } = await deriveMasterKeys(password, kdf);
  const userKey = generateKey();
  const vaultKey = generateKey();
  const protectedUserKey = await wrapKey(stretchedKey, userKey, aad.userKey(userId));
  const protectedVaultKey = await wrapKey(userKey, vaultKey, aad.vaultKey(vaultId));
  stretchedKey.fill(0);
  return { kdf, authKey, protectedUserKey, protectedVaultKey, userKey, vaultKey };
}
