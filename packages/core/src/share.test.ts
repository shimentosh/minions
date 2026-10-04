import { describe, expect, it } from "vitest";
import { DecryptionError, randomBytes } from "./crypto";
import { toBase64 } from "./encoding";
import {
  decryptSharePayload,
  deriveShareKeys,
  encryptSharePayload,
  fromBase64Url,
  newShareLinkKey,
  toBase64Url,
} from "./share";

const payload = {
  v: 1 as const,
  name: "GitHub",
  type: "LOGIN",
  fields: [{ label: "Password", value: "hunter2", sensitive: true }],
};

describe("share links", () => {
  it("round-trips with the link key alone", async () => {
    const link = newShareLinkKey();
    const { encKey } = await deriveShareKeys(link);
    const env = await encryptSharePayload(encKey, "s1", payload);
    const again = await deriveShareKeys(fromBase64Url(toBase64Url(link)));
    expect(await decryptSharePayload(again.encKey, "s1", env)).toEqual(payload);
  });

  it("needs the passphrase too when one is set", async () => {
    const link = newShareLinkKey();
    const salt = toBase64(randomBytes(16));
    const right = await deriveShareKeys(link, { value: "blue horse", salt });
    const env = await encryptSharePayload(right.encKey, "s2", payload);
    const wrong = await deriveShareKeys(link, { value: "red horse", salt });
    expect(wrong.accessToken).not.toBe(right.accessToken);
    await expect(decryptSharePayload(wrong.encKey, "s2", env)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    // The access token proves the passphrase but cannot decrypt.
    const linkOnly = await deriveShareKeys(link);
    await expect(decryptSharePayload(linkOnly.encKey, "s2", env)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("is bound to its share id", async () => {
    const { encKey } = await deriveShareKeys(newShareLinkKey());
    const env = await encryptSharePayload(encKey, "s3", payload);
    await expect(decryptSharePayload(encKey, "other", env)).rejects.toBeInstanceOf(DecryptionError);
  });
});
