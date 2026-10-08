import { wipe } from "@minions/core";
import { onVaultClosed } from "./session";

/**
 * Keys of the items this client opened that have their own key, in memory
 * only: workspace items, personal items shared with people, and items other
 * people shared with this user. Code that reveals, copies or encrypts a field
 * asks here first; anything not registered is a personal item under the vault
 * key. Locking empties the registry.
 */

/** Where an item with its own key lives, which decides its API path. */
export type ItemScope =
  | { kind: "workspace"; workspaceId: string }
  /** The caller's own item, shared with people. */
  | { kind: "personal" }
  /** Someone else's item, shared with the caller. */
  | { kind: "shared" };

const keys = new Map<string, { key: Uint8Array<ArrayBuffer>; scope: ItemScope }>();

onVaultClosed(() => {
  for (const { key } of keys.values()) wipe(key);
  keys.clear();
});

export function registerItemKey(itemId: string, scope: ItemScope, key: Uint8Array<ArrayBuffer>) {
  const prev = keys.get(itemId);
  if (prev && prev.key !== key) wipe(prev.key);
  keys.set(itemId, { key, scope });
}

export function forgetItemKey(itemId: string) {
  const prev = keys.get(itemId);
  if (prev) wipe(prev.key);
  keys.delete(itemId);
}

export function itemKeyFor(itemId: string) {
  return keys.get(itemId)?.key ?? null;
}

export function scopeOf(itemId: string): ItemScope | null {
  return keys.get(itemId)?.scope ?? null;
}

export function workspaceOf(itemId: string) {
  const scope = scopeOf(itemId);
  return scope?.kind === "workspace" ? scope.workspaceId : null;
}

/** The API path of an item, personal, workspace or shared with the caller. */
export function itemPath(itemId: string) {
  const scope = scopeOf(itemId);
  if (scope?.kind === "workspace") return `/workspaces/${scope.workspaceId}/items/${itemId}`;
  if (scope?.kind === "shared") return `/shared/items/${itemId}`;
  return `/vault/items/${itemId}`;
}
