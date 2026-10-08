import {
  type AccessGrantInput,
  CUSTOM_FIELD_PREFIX,
  encryptBytes,
  type FieldKind,
  generateKey,
  type ItemAccessResponse,
  type ItemPermission,
  keyAad,
  openSealedKey,
  sealContext,
  sealKey,
  type UpdateItemAccessRequest,
  unwrapKey,
  type WorkspaceDetail,
  type WorkspaceItemDetail,
  type WorkspaceMember,
  wipe,
} from "@minions/core";
import { get, post } from "./api";
import { itemKeyFor, registerItemKey } from "./item-keys";
import { onVaultClosed, requireSharingKeys } from "./session";
import { decryptAll, encryptDraft } from "./vault-crypto";

/**
 * Workspace cryptography on the client. See ARCHITECTURE.md §7.
 *
 *  workspace key  random 256-bit, sealed (RSA-OAEP) to each confirmed member
 *  item key       random 256-bit per item; fields are AES-GCM under it, with
 *                 the same AAD as personal items
 *  grant          the item key sealed to one member
 *  "everyone"     the item key wrapped (AES-GCM) by the workspace key
 *
 * The server stores all of these and can open none of them.
 */

const workspaceKeys = new Map<string, Uint8Array<ArrayBuffer>>();
onVaultClosed(() => {
  for (const k of workspaceKeys.values()) wipe(k);
  workspaceKeys.clear();
});

export function workspaceKeyFrom(workspaceId: string, detail: WorkspaceDetail) {
  return openWorkspaceKey(workspaceId, detail.protectedWorkspaceKey);
}

async function openWorkspaceKey(workspaceId: string, sealed: string | null) {
  const cached = workspaceKeys.get(workspaceId);
  if (cached) return cached;
  if (!sealed) throw new Error("An admin has not confirmed your membership yet.");
  const { privateKey, userId } = requireSharingKeys();
  const key = await openSealedKey(
    privateKey,
    sealed,
    sealContext.workspaceKey(workspaceId, userId),
  );
  workspaceKeys.set(workspaceId, key);
  return key;
}

export async function workspaceKey(workspaceId: string) {
  const cached = workspaceKeys.get(workspaceId);
  if (cached) return cached;
  const detail = await get<WorkspaceDetail>(`/workspaces/${workspaceId}`);
  return openWorkspaceKey(workspaceId, detail.protectedWorkspaceKey);
}

/** Opens an item's key from whichever envelope the server gave this member, and remembers it. */
export async function openItemKey(item: WorkspaceItemDetail) {
  let key: Uint8Array<ArrayBuffer>;
  if (item.key.source === "grant") {
    const { privateKey, userId } = requireSharingKeys();
    key = await openSealedKey(privateKey, item.key.wrapped, sealContext.itemKey(item.id, userId));
  } else {
    const wsKey = await workspaceKey(item.workspaceId);
    key = await unwrapKey(
      wsKey,
      item.key.wrapped,
      keyAad.itemKeyForWorkspace(item.workspaceId, item.id),
    );
  }
  registerItemKey(item.id, { kind: "workspace", workspaceId: item.workspaceId }, key);
  return key;
}

/** Fetches a workspace item and opens its key, ready for revealField/encryptDraft. */
export async function loadWorkspaceItem(workspaceId: string, itemId: string) {
  const item = await get<WorkspaceItemDetail>(`/workspaces/${workspaceId}/items/${itemId}`);
  await openItemKey(item);
  return item;
}

export async function createWorkspace(name: string) {
  const { publicKey, userId } = requireSharingKeys();
  const id = crypto.randomUUID();
  const key = generateKey();
  await post("/workspaces", {
    id,
    name,
    protectedWorkspaceKey: await sealKey(publicKey, key, sealContext.workspaceKey(id, userId)),
  });
  workspaceKeys.set(id, key);
  return id;
}

/** Hands the workspace key to a member who joined, sealed to the public key the server reports. */
export async function confirmMember(workspaceId: string, member: WorkspaceMember) {
  if (!member.publicKey || !member.userId) throw new Error("This member has no sharing key yet.");
  const key = await workspaceKey(workspaceId);
  await post(`/workspaces/${workspaceId}/members/${member.id}/confirm`, {
    protectedWorkspaceKey: await sealKey(
      member.publicKey,
      key,
      sealContext.workspaceKey(workspaceId, member.userId),
    ),
  });
}

export interface DesiredGrant {
  userId: string;
  publicKey: string;
  permission: ItemPermission;
}

/**
 * The access request for an item: seals the item key to each member who does
 * not have it yet (or to everyone, for a re-key), and wraps it with the
 * workspace key when shared with the whole workspace.
 */
export async function buildAccess(opts: {
  workspaceId: string;
  itemId: string;
  itemKey: Uint8Array<ArrayBuffer>;
  workspaceShared: boolean;
  grants: DesiredGrant[];
  /** Members who already hold the key; they need no new seal. */
  existing?: Set<string>;
  sealAll?: boolean;
}): Promise<UpdateItemAccessRequest> {
  const grants: AccessGrantInput[] = [];
  for (const g of opts.grants) {
    const needsKey = opts.sealAll || !opts.existing?.has(g.userId);
    grants.push({
      userId: g.userId,
      permission: g.permission,
      ...(needsKey
        ? {
            protectedItemKey: await sealKey(
              g.publicKey,
              opts.itemKey,
              sealContext.itemKey(opts.itemId, g.userId),
            ),
          }
        : {}),
    });
  }
  return {
    workspaceShared: opts.workspaceShared,
    ...(opts.workspaceShared
      ? {
          workspaceWrappedKey: await encryptBytes(
            await workspaceKey(opts.workspaceId),
            opts.itemKey,
            keyAad.itemKeyForWorkspace(opts.workspaceId, opts.itemId),
          ),
        }
      : {}),
    grants,
  };
}

/** A fresh key for a new item, registered so encryptDraft uses it. */
export function newItemKey(workspaceId: string, itemId: string) {
  const key = generateKey();
  registerItemKey(itemId, { kind: "workspace", workspaceId }, key);
  return key;
}

/**
 * Rotates the workspace key after someone who held it left: a new key sealed
 * to every confirmed member, and every workspace-shared item's key re-wrapped.
 */
export async function rekeyWorkspace(workspaceId: string) {
  const members = await get<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  const confirmed = members.filter((m) => m.status === "CONFIRMED" && m.userId && m.publicKey);
  // Every workspace-shared item, the trash included; their keys come from the old workspace key.
  const items: { id: string; key: Uint8Array<ArrayBuffer> }[] = [];
  for (const trash of [false, true]) {
    let cursor: string | undefined;
    do {
      const page = await get<{
        items: { id: string; workspaceShared: boolean }[];
        nextCursor: string | null;
      }>(`/workspaces/${workspaceId}/items`, {
        limit: 200,
        trash: trash ? "true" : undefined,
        cursor,
      });
      for (const i of page.items.filter((x) => x.workspaceShared)) {
        const detail = await loadWorkspaceItem(workspaceId, i.id);
        items.push({ id: i.id, key: await openItemKey(detail) });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  const next = generateKey();
  const body = {
    members: await Promise.all(
      confirmed.map(async (m) => ({
        userId: m.userId!,
        protectedWorkspaceKey: await sealKey(
          m.publicKey!,
          next,
          sealContext.workspaceKey(workspaceId, m.userId!),
        ),
      })),
    ),
    items: await Promise.all(
      items.map(async (i) => ({
        itemId: i.id,
        workspaceWrappedKey: await encryptBytes(
          next,
          i.key,
          keyAad.itemKeyForWorkspace(workspaceId, i.id),
        ),
      })),
    ),
  };
  await post(`/workspaces/${workspaceId}/rekey`, body);
  const old = workspaceKeys.get(workspaceId);
  if (old) wipe(old);
  workspaceKeys.set(workspaceId, next);
}

/**
 * Replaces one item's key after someone who held it lost access: decrypt with
 * the old key, encrypt every field under a new one, seal the new key to
 * everyone who keeps access. The server applies it in one transaction.
 */
export async function rekeyItem(item: WorkspaceItemDetail, access: ItemAccessResponse) {
  const ws = item.workspaceId;
  const members = await get<WorkspaceMember[]>(`/workspaces/${ws}/members`);
  const keys = new Map(members.map((m) => [m.userId, m.publicKey]));
  const oldKey = itemKeyFor(item.id);
  if (!oldKey) throw new Error("Open the credential again.");
  const plain = await decryptAll(item);
  // Registering the new key wipes the old buffer; keep a copy in case the server refuses.
  const previous = new Uint8Array(oldKey);
  const next = generateKey();
  registerItemKey(item.id, { kind: "workspace", workspaceId: ws }, next);
  try {
    const body = await encryptDraft({
      id: item.id,
      type: item.type,
      name: item.name,
      description: item.description,
      collectionId: item.collection?.id ?? null,
      favorite: item.favorite,
      tags: item.tags,
      values: plain,
      custom: item.fields
        .filter((f) => f.key.startsWith(CUSTOM_FIELD_PREFIX))
        .map((f) => ({
          key: f.key,
          label: f.label ?? f.key,
          sensitive: f.sensitive,
          kind: f.kind as FieldKind | undefined,
        })),
      revision: item.revision,
    });
    const grants = access.grants.map((g) => {
      const publicKey = keys.get(g.userId);
      if (!publicKey) throw new Error(`${g.name} has no sharing key`);
      return { userId: g.userId, publicKey, permission: g.permission };
    });
    const accessBody = await buildAccess({
      workspaceId: ws,
      itemId: item.id,
      itemKey: next,
      workspaceShared: access.workspaceShared,
      grants,
      sealAll: true,
    });
    await post(`/workspaces/${ws}/items/${item.id}/rekey`, { item: body, access: accessBody });
  } catch (e) {
    // Nothing changed on the server: keep using the old key.
    registerItemKey(item.id, { kind: "workspace", workspaceId: ws }, previous);
    throw e;
  }
  wipe(previous);
}
