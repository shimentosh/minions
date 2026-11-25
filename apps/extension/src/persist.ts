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

// ─── "Remember on this computer" ─────────────────────────────────────────────
// Only when the user turns it on. The vault keys are kept encrypted under an
// AES key that cannot be read out by script (a non-extractable CryptoKey),
// in this extension's own IndexedDB. Locking or signing out deletes both.
// This protects against other extensions, websites and casual copying of
// files; not against someone using this computer account, which is the
// trade-off the user chose for not typing the master password again.

export interface RememberedKeys {
  userId: string;
  vaultId: string;
  vaultKey: string;
  privateKey: string | null;
}

const DEVICE_KEY = "deviceKey";
const REMEMBERED = "remembered";

export const remembered = {
  async save(v: RememberedKeys) {
    let key = await run<CryptoKey | undefined>("readonly", (s) => s.get(DEVICE_KEY));
    if (!key) {
      key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      await run("readwrite", (s) => s.put(key, DEVICE_KEY));
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(v)),
    );
    await run("readwrite", (s) => s.put({ iv, data }, REMEMBERED));
  },
  async load(): Promise<RememberedKeys | null> {
    const key = await run<CryptoKey | undefined>("readonly", (s) => s.get(DEVICE_KEY)).catch(
      () => undefined,
    );
    const box = await run<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | undefined>(
      "readonly",
      (s) => s.get(REMEMBERED),
    ).catch(() => undefined);
    if (!key || !box) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: box.iv }, key, box.data);
      return JSON.parse(new TextDecoder().decode(plain)) as RememberedKeys;
    } catch {
      return null;
    }
  },
  async clear() {
    await run("readwrite", (s) => s.delete(REMEMBERED)).catch(() => undefined);
    await run("readwrite", (s) => s.delete(DEVICE_KEY)).catch(() => undefined);
  },
};
