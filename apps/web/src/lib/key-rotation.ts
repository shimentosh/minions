import {
  aad,
  DecryptionError,
  decryptString,
  encryptString,
  getItemType,
  keyAad,
  secretFingerprint,
  unwrapKey,
  wipe,
  wrapKey,
} from "@minions/core";
import { get, post } from "./api";
import { useSession } from "./session";

/**
 * Re-encrypts the personal vault from one vault key to another. Runs only on
 * this device: the server hands out ciphertext under the old key and accepts
 * ciphertext under the new one, checking every secret comes back encrypted.
 * Safe to run again after an interruption: rows already moved are skipped.
 * See apps/api/src/vault/rotation.ts.
 */

export interface RotationProgress {
  done: number;
  total: number;
}

interface ItemRow {
  id: string;
  type: string;
  hasPasswordFingerprint: boolean;
  /** Items shared with people: their own key, wrapped by the vault key. */
  protectedItemKey: string | null;
  fields: { key: string; value: string }[];
  versions: { id: string; fields: { key: string; value: string }[] }[];
}

interface NoteRow {
  id: string;
  contentEnc: string | null;
  versions: { id: string; contentEnc: string | null }[];
}

interface Status {
  inProgress: boolean;
  remaining: { items: number; notes: number };
}

type Key = Uint8Array<ArrayBuffer>;

/** Requests stay well under the API's 3 MB body limit. */
const FLUSH_BYTES = 1_000_000;

async function reencrypt(oldKey: Key, newKey: Key, envelope: string, context: string) {
  let plain: string;
  try {
    plain = await decryptString(oldKey, envelope, context);
  } catch (e) {
    if (!(e instanceof DecryptionError)) throw e;
    // Already under the new key (a retried batch): keep it as it is.
    await decryptString(newKey, envelope, context);
    return { value: envelope, plain: null };
  }
  return { value: await encryptString(newKey, plain, context), plain };
}

/**
 * An item shared with people keeps its own key (recipients hold it sealed):
 * only the wrapper moves to the new vault key. Its fingerprint is recomputed.
 */
async function rotateKeyedItem(oldKey: Key, newKey: Key, row: ItemRow) {
  const vaultId = useSession.getState().me?.vaultId;
  if (!vaultId) throw new Error("Vault is locked");
  const context = keyAad.itemKeyForVault(vaultId, row.id);
  let itemKey: Key;
  try {
    itemKey = await unwrapKey(oldKey, row.protectedItemKey!, context);
  } catch (e) {
    if (!(e instanceof DecryptionError)) throw e;
    itemKey = await unwrapKey(newKey, row.protectedItemKey!, context);
  }
  try {
    const passwordField = getItemType(row.type)?.passwordField;
    const pw = row.fields.find((f) => f.key === passwordField);
    return {
      id: row.id,
      fields: [],
      versions: [],
      protectedItemKey: await wrapKey(newKey, itemKey, context),
      ...(row.hasPasswordFingerprint && pw
        ? {
            passwordFingerprint: await secretFingerprint(
              newKey,
              await decryptString(itemKey, pw.value, aad.field(row.id, pw.key)),
            ),
          }
        : {}),
    };
  } finally {
    wipe(itemKey);
  }
}

async function rotateItem(oldKey: Key, newKey: Key, row: ItemRow) {
  if (row.protectedItemKey) return rotateKeyedItem(oldKey, newKey, row);
  const passwordField = getItemType(row.type)?.passwordField;
  let password: string | null = null;
  const fields = [];
  for (const f of row.fields) {
    const r = await reencrypt(oldKey, newKey, f.value, aad.field(row.id, f.key));
    if (f.key === passwordField) password = r.plain;
    fields.push({ key: f.key, value: r.value });
  }
  const versions = [];
  for (const v of row.versions) {
    const vf = [];
    for (const f of v.fields)
      vf.push({
        key: f.key,
        value: (await reencrypt(oldKey, newKey, f.value, aad.version(row.id, f.key))).value,
      });
    versions.push({ id: v.id, fields: vf });
  }
  return {
    id: row.id,
    fields,
    versions,
    ...(row.hasPasswordFingerprint && password !== null
      ? { passwordFingerprint: await secretFingerprint(newKey, password) }
      : {}),
  };
}

async function rotateNote(oldKey: Key, newKey: Key, row: NoteRow) {
  const context = aad.note(row.id);
  const body = async (enc: string | null) =>
    enc ? (await reencrypt(oldKey, newKey, enc, context)).value : null;
  const versions = [];
  for (const v of row.versions) versions.push({ id: v.id, contentEnc: await body(v.contentEnc) });
  return { id: row.id, contentEnc: await body(row.contentEnc), versions };
}

/** Moves every remaining row to the new key, then has the server swap the wrapped key. */
export async function runRotation(
  oldKey: Key,
  newKey: Key,
  onProgress?: (p: RotationProgress) => void,
): Promise<void> {
  const status = await get<Status>("/vault/rotation");
  if (!status.inProgress) return;
  const total = status.remaining.items + status.remaining.notes;
  let done = 0;
  onProgress?.({ done, total });

  for (const kind of ["items", "notes"] as const) {
    for (;;) {
      const page = await get<{ items?: ItemRow[]; notes?: NoteRow[] }>("/vault/rotation/batch", {
        kind,
        limit: kind === "items" ? 50 : 10,
      });
      const rows = (kind === "items" ? page.items : page.notes) ?? [];
      if (!rows.length) break;
      let pending: unknown[] = [];
      let bytes = 0;
      const flush = async () => {
        if (!pending.length) return;
        await post("/vault/rotation/batch", { [kind]: pending });
        done += pending.length;
        onProgress?.({ done, total });
        pending = [];
        bytes = 0;
      };
      for (const row of rows) {
        const next =
          kind === "items"
            ? await rotateItem(oldKey, newKey, row as ItemRow)
            : await rotateNote(oldKey, newKey, row as NoteRow);
        const size = JSON.stringify(next).length;
        if (bytes + size > FLUSH_BYTES) await flush();
        pending.push(next);
        bytes += size;
      }
      await flush();
    }
  }
  await post("/vault/rotation/finish");
  onProgress?.({ done: total, total });
}
