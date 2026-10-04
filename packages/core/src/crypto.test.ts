import { describe, expect, it } from "vitest";
import {
  aad,
  createAccountKeys,
  DecryptionError,
  decryptString,
  deriveMasterKeys,
  encryptString,
  generateKey,
  isEnvelope,
  type KdfParams,
  secretFingerprint,
  unwrapKey,
} from "./crypto";
import { fromBase64, toBase64 } from "./encoding";

// Small KDF for test speed; production params are enforced by the server.
const FAST_KDF: KdfParams = {
  type: "argon2id",
  memory: 1024,
  iterations: 1,
  parallelism: 1,
  salt: "AAAAAAAAAAAAAAAAAAAAAA==",
};

describe("encryption", () => {
  it("round-trips a value", async () => {
    const key = generateKey();
    const env = await encryptString(key, "hunter2 🔑", aad.field("i1", "password"));
    expect(isEnvelope(env)).toBe(true);
    expect(env).not.toContain("hunter2");
    expect(await decryptString(key, env, aad.field("i1", "password"))).toBe("hunter2 🔑");
  });

  it("uses a fresh IV every time", async () => {
    const key = generateKey();
    const a = await encryptString(key, "same", "ctx");
    const b = await encryptString(key, "same", "ctx");
    expect(a).not.toBe(b);
  });

  it("rejects the wrong key", async () => {
    const env = await encryptString(generateKey(), "secret", "ctx");
    await expect(decryptString(generateKey(), env, "ctx")).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects tampered ciphertext", async () => {
    const key = generateKey();
    const env = await encryptString(key, "secret", "ctx");
    const [v, iv, ct] = env.split(".");
    const bytes = fromBase64(ct!);
    bytes[0]! ^= 0x01;
    await expect(decryptString(key, `${v}.${iv}.${toBase64(bytes)}`, "ctx")).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("rejects a ciphertext moved to another field or item", async () => {
    const key = generateKey();
    const env = await encryptString(key, "secret", aad.field("item-a", "password"));
    await expect(decryptString(key, env, aad.field("item-a", "api_key"))).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(decryptString(key, env, aad.field("item-b", "password"))).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("rejects malformed envelopes", async () => {
    expect(isEnvelope("plaintext")).toBe(false);
    expect(isEnvelope("v1.abc.def")).toBe(false);
    await expect(
      decryptString(generateKey(), "v2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA", "x"),
    ).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe("key hierarchy", () => {
  it("derives the same keys from the same password and different from another", async () => {
    const a = await deriveMasterKeys("correct horse", FAST_KDF);
    const b = await deriveMasterKeys("correct horse", FAST_KDF);
    const c = await deriveMasterKeys("correct horsf", FAST_KDF);
    expect(a.authKey).toBe(b.authKey);
    expect(a.authKey).not.toBe(c.authKey);
    // The auth key sent to the server is not the encryption key.
    expect(a.authKey).not.toBe(toBase64(a.stretchedKey));
  });

  it("unwraps user and vault keys only with the right password", async () => {
    const reg = await createAccountKeys("master pw", "u1", "v1", FAST_KDF);
    const { stretchedKey } = await deriveMasterKeys("master pw", FAST_KDF);
    const userKey = await unwrapKey(stretchedKey, reg.protectedUserKey, aad.userKey("u1"));
    const vaultKey = await unwrapKey(userKey, reg.protectedVaultKey, aad.vaultKey("v1"));
    expect(toBase64(vaultKey)).toBe(toBase64(reg.vaultKey));

    const wrong = await deriveMasterKeys("master pW", FAST_KDF);
    await expect(
      unwrapKey(wrong.stretchedKey, reg.protectedUserKey, aad.userKey("u1")),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("fingerprints are stable per vault and differ across vaults", async () => {
    const k1 = generateKey();
    const k2 = generateKey();
    expect(await secretFingerprint(k1, "pw")).toBe(await secretFingerprint(k1, "pw"));
    expect(await secretFingerprint(k1, "pw")).not.toBe(await secretFingerprint(k2, "pw"));
    expect(await secretFingerprint(k1, "pw")).toMatch(/^[0-9a-f]{64}$/);
  });
});
