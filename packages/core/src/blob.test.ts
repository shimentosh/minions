import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  decryptBlob,
  encryptBlob,
  generateKey,
  isEncryptedBlob,
  pageAad,
} from "./crypto";

describe("encrypted blobs (page files)", () => {
  it("round-trips bytes and binds them to their page and file", async () => {
    const key = generateKey();
    const bytes = new Uint8Array(5000).map((_, i) => i % 251);
    const ctx = pageAad.file("p1", "f1");
    const blob = await encryptBlob(key, bytes, ctx);
    expect(isEncryptedBlob(blob)).toBe(true);
    expect(blob.length).toBe(bytes.length + 1 + 12 + 16);
    expect(Array.from(await decryptBlob(key, blob, ctx))).toEqual(Array.from(bytes));
    await expect(decryptBlob(key, blob, pageAad.file("p1", "f2"))).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(decryptBlob(generateKey(), blob, ctx)).rejects.toBeInstanceOf(DecryptionError);
    const tampered = blob.slice();
    tampered[40] = tampered[40]! ^ 1;
    await expect(decryptBlob(key, tampered, ctx)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("does not take plaintext for a blob", () => {
    expect(isEncryptedBlob(new TextEncoder().encode("hello world, not encrypted at all"))).toBe(
      false,
    );
    expect(isEncryptedBlob(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
