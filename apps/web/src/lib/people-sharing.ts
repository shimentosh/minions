import {
  aad,
  type CreatePeopleShareRequest,
  decryptString,
  encryptString,
  generateKey,
  type ItemKeyMaterial,
  keyAad,
  openSealedKey,
  type PendingSeal,
  type PeoplePermission,
  type PeopleShare,
  publicKeyFingerprint,
  type SetItemKeyRequest,
  type SharedItemDetail,
  type ShareRecipientLookup,
  sealContext,
  sealKey,
  unwrapKey,
  type VaultItemDetail,
  wipe,
  wrapKey,
} from "@minions/core";
import { get, post } from "./api";
import { itemKeyFor, registerItemKey } from "./item-keys";
import { requireSharingKeys, requireVaultKey, useSession } from "./session";

/**
 * Sharing personal items with people, on the client. See ARCHITECTURE.md §8.
 *
 *  item key   random 256-bit, given to an item the first time it is shared;
 *             its fields (and history) are re-encrypted under it, and it is
 *             wrapped by the vault key so the owner keeps opening it
 *  seal       the item key encrypted to one recipient's public key
 *
 * The server stores both and can open neither.
 */

type Key = Uint8Array<ArrayBuffer>;

function vaultId() {
  const id = useSession.getState().me?.vaultId;
  if (!id) throw new Error("Vault is locked");
  return id;
}

async function unwrapItemKey(itemId: string, protectedItemKey: string) {
  return unwrapKey(requireVaultKey(), protectedItemKey, keyAad.itemKeyForVault(vaultId(), itemId));
}

/** Opens a personal item's own key, when it has one, so fields decrypt with it. */
export async function openPersonalItem<T extends Pick<VaultItemDetail, "id" | "protectedItemKey">>(
  item: T,
): Promise<T> {
  if (item.protectedItemKey)
    registerItemKey(
      item.id,
      { kind: "personal" },
      await unwrapItemKey(item.id, item.protectedItemKey),
    );
  return item;
}

export async function loadPersonalItem(id: string) {
  return openPersonalItem(await get<VaultItemDetail>(`/vault/items/${id}`));
}

/** Opens the key of an item someone shared with this user. */
export async function openSharedItem(item: SharedItemDetail) {
  const { privateKey, userId } = requireSharingKeys();
  const key = await openSealedKey(
    privateKey,
    item.sealedItemKey,
    sealContext.itemKey(item.id, userId),
  );
  registerItemKey(item.id, { kind: "shared" }, key);
  return item;
}

export async function loadSharedItem(id: string) {
  return openSharedItem(await get<SharedItemDetail>(`/shared/items/${id}`));
}

/** Every secret and version of an item, moved from one key to another. */
async function reencrypt(itemId: string, from: Key, to: Key, material: ItemKeyMaterial) {
  const move = async (value: string, context: string) =>
    encryptString(to, await decryptString(from, value, context), context);
  const fields = [];
  for (const f of material.fields)
    fields.push({ key: f.key, value: await move(f.value, aad.field(itemId, f.key)) });
  const versions = [];
  for (const v of material.versions) {
    const vf = [];
    for (const f of v.fields)
      vf.push({ key: f.key, value: await move(f.value, aad.version(itemId, f.key)) });
    versions.push({ id: v.id, fields: vf });
  }
  return { fields, versions };
}

/**
 * Gives the item a new key: first share (from the vault key) or after someone
 * lost access (from the old item key). Everyone who keeps access gets the
 * new key sealed to them in the same request.
 */
export async function setNewItemKey(itemId: string): Promise<Key> {
  const material = await get<ItemKeyMaterial>(`/vault/items/${itemId}/item-key`);
  const vaultKey = requireVaultKey();
  const old = material.protectedItemKey
    ? await unwrapItemKey(itemId, material.protectedItemKey)
    : vaultKey;
  const next = generateKey();
  try {
    const moved = await reencrypt(itemId, old, next, material);
    const body: SetItemKeyRequest = {
      ...moved,
      revision: material.revision,
      protectedItemKey: await wrapKey(vaultKey, next, keyAad.itemKeyForVault(vaultId(), itemId)),
      seals: await Promise.all(
        material.holders.map(async (h) => ({
          shareId: h.shareId,
          sealedItemKey: await sealKey(h.publicKey, next, sealContext.itemKey(itemId, h.userId)),
        })),
      ),
    };
    await post(`/vault/items/${itemId}/item-key`, body);
  } catch (e) {
    wipe(next);
    throw e;
  } finally {
    if (old !== vaultKey) wipe(old);
  }
  registerItemKey(itemId, { kind: "personal" }, next);
  return next;
}

/** The item's own key, creating it the first time the item is shared. */
async function ensureItemKey(item: VaultItemDetail): Promise<Key> {
  const open = itemKeyFor(item.id);
  if (open) return open;
  if (item.protectedItemKey) {
    await openPersonalItem(item);
    return itemKeyFor(item.id)!;
  }
  return setNewItemKey(item.id);
}

export function lookupRecipient(email: string) {
  return get<ShareRecipientLookup>("/people-shares/lookup", { email });
}

export function fingerprintOf(publicKey: string) {
  return publicKeyFingerprint(publicKey);
}

/**
 * Shares an item with an email. Someone who can receive it now gets the key
 * sealed immediately; anyone else is invited and gets it once they can.
 */
export async function shareWithPerson(
  item: VaultItemDetail,
  opts: { email: string; permission: PeoplePermission; expiresInMinutes: number },
): Promise<PeopleShare> {
  const key = await ensureItemKey(item);
  const { recipient } = await lookupRecipient(opts.email);
  const body: CreatePeopleShareRequest = {
    email: opts.email,
    permission: opts.permission,
    expiresInMinutes: opts.expiresInMinutes,
    ...(recipient
      ? {
          recipientUserId: recipient.id,
          sealedItemKey: await sealKey(
            recipient.publicKey,
            key,
            sealContext.itemKey(item.id, recipient.id),
          ),
        }
      : {}),
  };
  return post<PeopleShare>(`/vault/items/${item.id}/people`, body);
}

let sealing: Promise<PendingSeal[]> | null = null;

/**
 * Hands over every share whose recipient has become able to receive it
 * (signed up, confirmed their email, unlocked once). Runs while the vault is
 * open; returns what it completed.
 */
export function completePendingSeals(): Promise<PendingSeal[]> {
  sealing ??= (async () => {
    const done: PendingSeal[] = [];
    try {
      const pending = await get<PendingSeal[]>("/people-shares/pending-seals");
      for (const p of pending) {
        try {
          const key = await unwrapItemKey(p.itemId, p.protectedItemKey);
          try {
            await post(`/people-shares/${p.shareId}/seal`, {
              recipientUserId: p.recipient.id,
              protectedItemKey: p.protectedItemKey,
              sealedItemKey: await sealKey(
                p.recipient.publicKey,
                key,
                sealContext.itemKey(p.itemId, p.recipient.id),
              ),
            });
            done.push(p);
          } finally {
            wipe(key);
          }
        } catch {
          // One that fails (key changed meanwhile) is retried next time.
        }
      }
    } finally {
      sealing = null;
    }
    return done;
  })();
  return sealing;
}
