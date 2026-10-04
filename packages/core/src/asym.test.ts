import { describe, expect, it } from "vitest";
import {
  generateUserKeyPair,
  isSealedKey,
  openPrivateKey,
  openSealedKey,
  protectPrivateKey,
  publicKeyFingerprint,
  sealContext,
  sealKey,
} from "./asym";
import { DecryptionError, generateKey } from "./crypto";

describe("workspace sharing keys", async () => {
  const userKey = generateKey();
  const alice = await generateUserKeyPair();
  const bob = await generateUserKeyPair();
  const aliceProtected = await protectPrivateKey(userKey, alice.privateKey, "alice");

  it("seals a key that only the recipient can open", async () => {
    const itemKey = generateKey();
    const sealed = await sealKey(bob.publicKey, itemKey, sealContext.itemKey("i1", "bob"));
    expect(isSealedKey(sealed)).toBe(true);
    const bobPriv = await crypto.subtle.importKey(
      "pkcs8",
      bob.privateKey,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
    const opened = await openSealedKey(bobPriv, sealed, sealContext.itemKey("i1", "bob"));
    expect([...opened]).toEqual([...itemKey]);

    const alicePriv = await openPrivateKey(userKey, aliceProtected, "alice");
    await expect(
      openSealedKey(alicePriv, sealed, sealContext.itemKey("i1", "bob")),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("binds the sealed key to its item and recipient", async () => {
    const sealed = await sealKey(
      alice.publicKey,
      generateKey(),
      sealContext.itemKey("i1", "alice"),
    );
    const priv = await openPrivateKey(userKey, aliceProtected, "alice");
    // The server moving it to another item, or presenting it as a workspace key, fails.
    await expect(
      openSealedKey(priv, sealed, sealContext.itemKey("i2", "alice")),
    ).rejects.toBeInstanceOf(DecryptionError);
    await expect(
      openSealedKey(priv, sealed, sealContext.workspaceKey("i1", "alice")),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("keeps the private key behind the user key", async () => {
    await expect(openPrivateKey(generateKey(), aliceProtected, "alice")).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(openPrivateKey(userKey, aliceProtected, "bob")).rejects.toBeInstanceOf(
      DecryptionError,
    );
    const priv = await openPrivateKey(userKey, aliceProtected, "alice");
    expect(priv.extractable).toBe(false);
  });

  it("gives stable, distinct fingerprints", async () => {
    const a = await publicKeyFingerprint(alice.publicKey);
    expect(a).toMatch(/^([0-9a-f]{8} ){4}[0-9a-f]{8}$/);
    expect(await publicKeyFingerprint(alice.publicKey)).toBe(a);
    expect(await publicKeyFingerprint(bob.publicKey)).not.toBe(a);
  });

  it("rejects malformed sealed keys", () => {
    expect(isSealedKey("r1.abc")).toBe(false);
    expect(isSealedKey("v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    expect(isSealedKey(42)).toBe(false);
  });
});
