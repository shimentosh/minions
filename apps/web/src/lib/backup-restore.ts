import {
  aad,
  DecryptionError,
  decryptString,
  deriveMasterKeys,
  type FieldKind,
  type KdfParams,
  keyAad,
  type UpsertItemRequest,
  unwrapKey,
  wipe,
} from "@minions/core";
import { get, patch, post } from "./api";
import { type CustomFieldInput, encryptDraft, encryptNote } from "./vault-crypto";

interface BackupField {
  key: string;
  label: string | null;
  kind: string | null;
  sensitive: boolean;
  value: string;
}

export interface MinionsBackup {
  format: "minions-encrypted-backup";
  version: number;
  exportedAt: string;
  keys: {
    userId: string;
    vaultId: string;
    kdf: KdfParams;
    protectedUserKey: string;
    protectedVaultKey: string;
  };
  projects: { id: string; name: string; description: string | null; color: string | null }[];
  collections: { id: string; name: string; description: string | null; color: string | null }[];
  items: {
    id: string;
    type: string;
    name: string;
    description: string | null;
    projectId: string | null;
    collectionId: string | null;
    favorite: boolean;
    tags: string[];
    usedByProjectIds: string[];
    /** Items shared with people: their own key, wrapped by the backup's vault key. */
    protectedItemKey?: string | null;
    fields: BackupField[];
    deletedAt: string | null;
  }[];
  notes: {
    id: string;
    title: string;
    contentEnc: string | null;
    projectId: string | null;
    collectionId: string | null;
    pinned: boolean;
    favorite: boolean;
    archivedAt: string | null;
    deletedAt: string | null;
    tags: string[];
  }[];
  relations: { fromItemId: string; toItemId: string; kind: string }[];
}

export interface RestoreSummary {
  restoredItems: number;
  skippedItems: number;
  restoredNotes: number;
  skippedNotes: number;
  failed: number;
}

export function parseBackup(text: string): MinionsBackup {
  const data = JSON.parse(text) as MinionsBackup;
  if (
    data?.format !== "minions-encrypted-backup" ||
    data.version !== 1 ||
    !data.keys?.protectedVaultKey
  ) {
    throw new Error("This is not a Minions encrypted backup");
  }
  return data;
}

/**
 * Restores a backup into the current vault. The backup is decrypted here
 * with the master password it was made with, each value is re-encrypted
 * under the current vault key, and only then sent. Items and notes already
 * in this vault are skipped, so restoring twice is harmless. Version history
 * is not restored.
 */
export async function restoreBackup(
  backup: MinionsBackup,
  backupPassword: string,
  opts: { includeTrash: boolean; onProgress: (done: number, total: number) => void },
): Promise<RestoreSummary> {
  // 1. Open the backup's own vault key.
  const { stretchedKey } = await deriveMasterKeys(backupPassword, backup.keys.kdf);
  let backupKey: Uint8Array<ArrayBuffer>;
  try {
    const userKey = await unwrapKey(
      stretchedKey,
      backup.keys.protectedUserKey,
      aad.userKey(backup.keys.userId),
    );
    backupKey = await unwrapKey(
      userKey,
      backup.keys.protectedVaultKey,
      aad.vaultKey(backup.keys.vaultId),
    );
    wipe(userKey);
  } catch (e) {
    if (e instanceof DecryptionError)
      throw new Error("That master password doesn't open this backup");
    throw e;
  } finally {
    wipe(stretchedKey);
  }

  try {
    // 2. Projects and collections, matched by name.
    const [projects, collections] = await Promise.all([
      get<{ id: string; name: string }[]>("/projects"),
      get<{ id: string; name: string }[]>("/collections"),
    ]);
    const projectIds = new Map<string, string>();
    const collectionIds = new Map<string, string>();
    for (const p of backup.projects) {
      const found = projects.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
      projectIds.set(
        p.id,
        found?.id ??
          (
            await post<{ id: string }>("/projects", {
              name: p.name,
              description: p.description,
              color: p.color,
            })
          ).id,
      );
    }
    for (const c of backup.collections) {
      const found = collections.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
      collectionIds.set(
        c.id,
        found?.id ??
          (
            await post<{ id: string }>("/collections", {
              name: c.name,
              description: c.description,
              color: c.color,
            })
          ).id,
      );
    }

    // 3. What is already here.
    const items = backup.items.filter((i) => opts.includeTrash || !i.deletedAt);
    const notes = backup.notes.filter((n) => opts.includeTrash || !n.deletedAt);
    const existingItems = new Set<string>();
    const existingNotes = new Set<string>();
    for (let i = 0; i < Math.max(items.length, notes.length); i += 5000) {
      const res = await post<{ itemIds: string[]; noteIds: string[] }>("/vault/existing", {
        itemIds: items.slice(i, i + 5000).map((x) => x.id),
        noteIds: notes.slice(i, i + 5000).map((x) => x.id),
      });
      for (const id of res.itemIds) existingItems.add(id);
      for (const id of res.noteIds) existingNotes.add(id);
    }

    const total = items.length + notes.length;
    let done = 0;
    const summary: RestoreSummary = {
      restoredItems: 0,
      skippedItems: 0,
      restoredNotes: 0,
      skippedNotes: 0,
      failed: 0,
    };
    const idMap = new Map<string, string>();

    // Plaintext for one item, then encrypted again under the current key.
    async function reencrypt(
      item: MinionsBackup["items"][number],
      id: string,
    ): Promise<UpsertItemRequest> {
      const values: Record<string, string> = {};
      const custom: CustomFieldInput[] = [];
      const fieldKey = item.protectedItemKey
        ? await unwrapKey(
            backupKey,
            item.protectedItemKey,
            keyAad.itemKeyForVault(backup.keys.vaultId, item.id),
          )
        : backupKey;
      for (const f of item.fields) {
        values[f.key] = f.sensitive
          ? await decryptString(fieldKey, f.value, aad.field(item.id, f.key))
          : f.value;
        if (f.label)
          custom.push({
            key: f.key,
            label: f.label,
            sensitive: f.sensitive,
            kind: (f.kind ?? "text") as FieldKind,
          });
      }
      if (fieldKey !== backupKey) wipe(fieldKey);
      return encryptDraft({
        id,
        type: item.type,
        name: item.name,
        description: item.description,
        projectId: item.projectId ? (projectIds.get(item.projectId) ?? null) : null,
        collectionId: item.collectionId ? (collectionIds.get(item.collectionId) ?? null) : null,
        favorite: item.favorite,
        tags: item.tags,
        usedByProjectIds: item.usedByProjectIds
          .map((p) => projectIds.get(p))
          .filter((p): p is string => !!p),
        values,
        custom,
      });
    }

    // 4. Items, in import batches.
    const job = await post<{ id: string }>("/imports", {
      source: "minions-backup",
      totalRecords: total,
      duplicateCount: 0,
      invalidCount: 0,
    });
    const todo = items.filter((i) => {
      if (existingItems.has(i.id)) {
        idMap.set(i.id, i.id);
        summary.skippedItems++;
        return false;
      }
      return true;
    });
    done += summary.skippedItems;
    for (let i = 0; i < todo.length; i += 100) {
      const slice = todo.slice(i, i + 100);
      const entries = [];
      for (const [n, item] of slice.entries()) {
        try {
          entries.push({ sourceRow: i + n, item: await reencrypt(item, item.id) });
        } catch {
          /* undecryptable: counted as failed below */
        }
      }
      const res = await post<{
        imported: number;
        failed: { sourceRow: number; reason?: string }[];
      }>(`/imports/${job.id}/items`, { entries });
      for (const e of entries) idMap.set(slice[e.sourceRow - i]!.id, slice[e.sourceRow - i]!.id);
      // The id is taken by another vault on this server (a backup restored
      // into a new account): restore under a fresh id instead.
      for (const f of res.failed) {
        const item = slice[f.sourceRow - i]!;
        idMap.delete(item.id);
        if (!f.reason?.includes("already exists")) continue;
        const fresh = crypto.randomUUID();
        const retry = await post<{ imported: number }>(`/imports/${job.id}/items`, {
          entries: [{ sourceRow: f.sourceRow, item: await reencrypt(item, fresh) }],
        });
        if (retry.imported) idMap.set(item.id, fresh);
      }
      done += slice.length;
      opts.onProgress(done, total);
    }

    summary.restoredItems = todo.filter((i) => idMap.has(i.id)).length;
    summary.failed = todo.length - summary.restoredItems;

    // 5. Notes.
    for (const note of notes) {
      done++;
      if (existingNotes.has(note.id)) {
        summary.skippedNotes++;
        continue;
      }
      try {
        const html = note.contentEnc
          ? await decryptString(backupKey, note.contentEnc, aad.note(note.id))
          : "";
        const create = async (id: string) =>
          post("/notes", {
            id,
            title: note.title,
            contentEnc: html ? await encryptNote(id, html) : null,
            projectId: note.projectId ? (projectIds.get(note.projectId) ?? null) : null,
            collectionId: note.collectionId ? (collectionIds.get(note.collectionId) ?? null) : null,
            tags: note.tags,
            pinned: note.pinned,
            favorite: note.favorite,
          });
        let id = note.id;
        await create(id).catch(async () => {
          id = crypto.randomUUID();
          await create(id);
        });
        if (note.archivedAt) await patch(`/notes/${id}`, { archived: true }).catch(() => undefined);
        summary.restoredNotes++;
      } catch {
        summary.failed++;
      }
      opts.onProgress(done, total);
    }

    // 6. Relationships between restored items.
    for (const r of backup.relations) {
      const from = idMap.get(r.fromItemId);
      const to = idMap.get(r.toItemId);
      if (from && to)
        await post("/relations", { fromItemId: from, toItemId: to, kind: r.kind }).catch(
          () => undefined,
        );
    }
    await post(`/imports/${job.id}/complete`, {
      skippedCount: summary.skippedItems + summary.skippedNotes,
    });
    return summary;
  } finally {
    wipe(backupKey);
  }
}
