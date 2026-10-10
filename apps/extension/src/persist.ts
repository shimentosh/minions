/**
 * The one thing the extension keeps across browser restarts: which account it
 * is signed in to and that session's token, so it stays connected and only
 * needs unlocking. Never a key or a secret: a token alone opens nothing, the
 * server still wants the vault unlocked, and the vault key never touches disk.
 *
 * Held in the extension origin's IndexedDB, not chrome.storage.local, which
 * content scripts on every website can read.
 */

export interface SignedIn {
  token: string;
  email: string;
  userId: string;
  name?: string;
  /** Connected through the Minions web app (unlocks again whenever it does). */
  linked?: boolean;
}

const DB = "minions";
const STORE = "kv";
const KEY = "signedIn";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const persisted = {
  async get(): Promise<SignedIn | null> {
    const v = await run<SignedIn | undefined>("readonly", (s) => s.get(KEY)).catch(() => undefined);
    return v && typeof v.token === "string" ? v : null;
  },
  async set(v: SignedIn) {
    await run("readwrite", (s) => s.put(v, KEY));
  },
  async clear() {
    await run("readwrite", (s) => s.delete(KEY)).catch(() => undefined);
  },
};
