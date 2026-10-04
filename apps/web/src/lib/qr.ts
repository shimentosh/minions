import { base32Encode, fromBase64, totpUri } from "@minions/core";
import jsQR from "jsqr";

/** Reads a QR code from an image (a screenshot or photo), on this device. */
export async function decodeQrImage(blob: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(blob);
  // Large screenshots are scaled down: jsQR is fast enough at ~1500px.
  const scale = Math.min(1, 1500 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

export interface MigratedAccount {
  issuer: string;
  account: string;
  uri: string;
}

/** Minimal protobuf reader for Google Authenticator's export payload. */
function readFields(bytes: Uint8Array): Map<number, (Uint8Array | number)[]> {
  const out = new Map<number, (Uint8Array | number)[]>();
  let i = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    while (i < bytes.length) {
      const b = bytes[i++]!;
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return result;
  };
  while (i < bytes.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    let value: Uint8Array | number;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const len = varint();
      value = bytes.subarray(i, i + len);
      i += len;
    } else if (wire === 1) {
      i += 8;
      continue;
    } else if (wire === 5) {
      i += 4;
      continue;
    } else break;
    out.set(field, [...(out.get(field) ?? []), value]);
  }
  return out;
}

/**
 * Google Authenticator → "Transfer accounts" shows QR codes holding
 * `otpauth-migration://offline?data=…`. This turns one into standard TOTP URIs.
 */
export function parseGoogleMigration(uri: string): MigratedAccount[] {
  const data = new URL(uri).searchParams.get("data");
  if (!data) return [];
  const payload = readFields(
    fromBase64(decodeURIComponent(data).replace(/-/g, "+").replace(/_/g, "/")),
  );
  const text = (v: Uint8Array | number | undefined) =>
    v instanceof Uint8Array ? new TextDecoder().decode(v) : "";
  return (payload.get(1) ?? [])
    .filter((p): p is Uint8Array => p instanceof Uint8Array)
    .map((p) => {
      const f = readFields(p);
      const secret = f.get(1)?.[0];
      const name = text(f.get(2)?.[0]);
      const issuer = text(f.get(3)?.[0]);
      const type = f.get(6)?.[0];
      if (!(secret instanceof Uint8Array) || type === 1) return null; // HOTP is not supported
      const account = name.includes(":") ? name.split(":").slice(1).join(":").trim() : name;
      const base = totpUri(base32Encode(secret), account || issuer, issuer || account || "Account");
      const digits = f.get(5)?.[0] === 2 ? "8" : "6";
      const algorithm =
        ({ 2: "SHA256", 3: "SHA512" } as Record<number, string>)[Number(f.get(4)?.[0])] ?? "SHA1";
      return {
        issuer,
        account,
        uri: base
          .replace("digits=6", `digits=${digits}`)
          .replace("algorithm=SHA1", `algorithm=${algorithm}`),
      };
    })
    .filter((a): a is MigratedAccount => !!a);
}
