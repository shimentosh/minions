import { wipe } from "@minions/core";
import { onVaultClosed } from "./session";

/**
 * Keys of the workspace items this client opened, in memory only. Code that
 * reveals, copies or encrypts a field asks here first: a workspace item uses
 * its own key and its own API path; anything else is a personal item under
 * the vault key. Locking empties the registry.
 */

const keys = new Map<string, { key: Uint8Array<ArrayBuffer>; workspaceId: string }>();

onVaultClosed(() => {
  for (const { key } of keys.values()) wipe(key);
  keys.clear();
});

export function registerItemKey(itemId: string, workspaceId: string, key: Uint8Array<ArrayBuffer>) {
  const prev = keys.get(itemId);
  if (prev && prev.key !== key) wipe(prev.key);
  keys.set(itemId, { key, workspaceId });
}

export function forgetItemKey(itemId: string) {
  const prev = keys.get(itemId);
  if (prev) wipe(prev.key);
  keys.delete(itemId);
}

export function itemKeyFor(itemId: string) {
  return keys.get(itemId)?.key ?? null;
}

export function workspaceOf(itemId: string) {
  return keys.get(itemId)?.workspaceId ?? null;
}

/** The API path of an item, personal or workspace. */
export function itemPath(itemId: string) {
  const ws = workspaceOf(itemId);
  return ws ? `/workspaces/${ws}/items/${itemId}` : `/vault/items/${itemId}`;
}
