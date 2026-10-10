import {
  type AuthResult,
  aad,
  createAccountKeys,
  decryptBytes,
  deriveMasterKeys,
  encryptBytes,
  generateKey,
  generateUserKeyPair,
  importPrivateKey,
  type MeResponse,
  openPrivateKey,
  protectPrivateKey,
  toBase64,
  unwrapKey,
  unwrapPrivateKeyBytes,
  type VaultKeys,
  wipe,
  wrapKey,
} from "@minions/core";
import {
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from "@simplewebauthn/browser";
import { create } from "zustand";
import { ApiError, del, get, onApiError, post, setBearerToken } from "./api";
import { forgetDesktopSession, rememberDesktopSession } from "./desktop";
import { deviceInfo } from "./device";
import { type RotationProgress, runRotation } from "./key-rotation";
import { queryClient } from "./query";

/**
 * Who is signed in and whether the vault is open.
 *
 * The vault key lives in this module's memory and nowhere else: not in
 * localStorage, sessionStorage, IndexedDB or the query cache. Locking wipes
 * it, and a reload means unlocking again.
 */

export type SessionStatus = "loading" | "signed-out" | "two-factor" | "locked" | "unlocked";

let vaultKey: Uint8Array<ArrayBuffer> | null = null;

export function requireVaultKey(): Uint8Array<ArrayBuffer> {
  if (!vaultKey) throw new Error("Vault is locked");
  return vaultKey;
}

/**
 * The sharing key pair (workspaces). The private key is a non-extractable
 * CryptoKey: page script can decrypt with it but cannot read it out. It is
 * dropped on lock with the vault key.
 */
let sharing: { userId: string; publicKey: string; privateKey: CryptoKey } | null = null;

export function requireSharingKeys() {
  if (!sharing) throw new Error("Sharing keys are not available. Lock and unlock again.");
  return sharing;
}

/**
 * The private key's PKCS#8 bytes, wrapped by the vault key, kept only so the
 * browser extension can be connected without the master password. It is no
 * more exposed than the vault key it sits beside, and goes with it on lock.
 */
let extensionPrivateKey: { userId: string; envelope: string } | null = null;
const handoffAad = (userId: string) => `extension-handoff:${userId}`;

async function keepForExtension(pkcs8: Uint8Array<ArrayBuffer>, userId: string) {
  extensionPrivateKey = vaultKey
    ? { userId, envelope: await encryptBytes(vaultKey, pkcs8, handoffAad(userId)) }
    : null;
}

/**
 * What the extension needs to open the same vault: raw key bytes, base64.
 * Only the extension bridge calls this, and only for this browser's extension.
 */
export async function keysForExtension(): Promise<{
  vaultKey: string;
  privateKey: string | null;
}> {
  const vk = requireVaultKey();
  let privateKey: string | null = null;
  if (extensionPrivateKey) {
    const pkcs8 = await decryptBytes(
      vk,
      extensionPrivateKey.envelope,
      handoffAad(extensionPrivateKey.userId),
    ).catch(() => null);
    if (pkcs8) {
      privateKey = toBase64(pkcs8);
      pkcs8.fill(0);
    }
  }
  return { vaultKey: toBase64(vk), privateKey };
}

const closeListeners = new Set<() => void>();
/** Lets key caches elsewhere (workspace keys, item keys) empty themselves on lock. */
export function onVaultClosed(listener: () => void) {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

/**
 * Opens the private key, or creates the key pair the first time an account
 * unlocks after sharing was added. Sharing failing to set up never blocks
 * opening the personal vault.
 */
async function openSharing(userKey: Uint8Array<ArrayBuffer>, keys: VaultKeys) {
  sharing = null;
  extensionPrivateKey = null;
  try {
    if (keys.publicKey && keys.protectedPrivateKey) {
      sharing = {
        userId: keys.userId,
        publicKey: keys.publicKey,
        privateKey: await openPrivateKey(userKey, keys.protectedPrivateKey, keys.userId),
      };
      const pkcs8 = await unwrapPrivateKeyBytes(userKey, keys.protectedPrivateKey, keys.userId);
      try {
        await keepForExtension(pkcs8, keys.userId);
      } finally {
        wipe(pkcs8);
      }
      return;
    }
    const pair = await generateUserKeyPair();
    try {
      await post("/account/keypair", {
        publicKey: pair.publicKey,
        protectedPrivateKey: await protectPrivateKey(userKey, pair.privateKey, keys.userId),
      });
      sharing = {
        userId: keys.userId,
        publicKey: pair.publicKey,
        privateKey: await importPrivateKey(pair.privateKey),
      };
      await keepForExtension(pair.privateKey, keys.userId);
    } finally {
      wipe(pair.privateKey);
    }
  } catch {
    sharing = null;
    extensionPrivateKey = null;
  }
}

interface SessionState {
  status: SessionStatus;
  me: MeResponse | null;
  /** Second factors offered for the pending sign-in. */
  twoFactorMethods: ("totp" | "passkey")[];
  refresh: () => Promise<void>;
  register: (input: { email: string; name: string; password: string }) => Promise<void>;
  login: (input: { email: string; password: string }) => Promise<"ok" | "two_factor_required">;
  verifyTwoFactor: (code: string) => Promise<void>;
  verifyPasskey: () => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: (opts?: { silent?: boolean }) => Promise<void>;
  logout: () => Promise<void>;
  emergencyLock: () => Promise<void>;
  setSettings: (settings: Partial<MeResponse["user"]>) => void;
}

// Between the password step and the 2FA step we hold the stretched key, so
// the user does not type the master password twice.
let pendingStretchedKey: Uint8Array<ArrayBuffer> | null = null;

async function openVault(stretchedKey: Uint8Array<ArrayBuffer>, keys: VaultKeys) {
  const userKey = await unwrapKey(stretchedKey, keys.protectedUserKey, aad.userKey(keys.userId));
  try {
    let next = await unwrapKey(userKey, keys.protectedVaultKey, aad.vaultKey(keys.vaultId));
    if (keys.pendingProtectedVaultKey) {
      // A vault-key change was interrupted (closed tab, lost connection).
      // Finish it now: until then part of the vault is under each key.
      const fresh = await unwrapKey(
        userKey,
        keys.pendingProtectedVaultKey,
        aad.vaultKey(keys.vaultId),
      );
      try {
        await runRotation(next, fresh);
      } catch (e) {
        wipe(fresh);
        wipe(next);
        throw e;
      }
      wipe(next);
      next = fresh;
    }
    wipe(vaultKey);
    vaultKey = next;
    await openSharing(userKey, keys);
  } finally {
    wipe(userKey);
  }
}

/**
 * Replaces the vault key: a new random key, every secret in the personal
 * vault re-encrypted under it on this device, then the wrapped key swapped on
 * the server. Other sessions are locked and must unlock again. Use after a
 * device that had the vault unlocked was lost or compromised: changing the
 * master password alone does not change the key that encrypts the data.
 */
export async function rotateVaultKey(
  password: string,
  onProgress?: (p: RotationProgress) => void,
): Promise<void> {
  const current = requireVaultKey();
  const { kdf } = await get<Pick<VaultKeys, "kdf">>("/vault/kdf");
  const { authKey, stretchedKey } = await deriveMasterKeys(password, kdf);
  const keys = await get<VaultKeys>("/vault/keys");
  let userKey: Uint8Array<ArrayBuffer> | null = null;
  let started = false;
  const fresh = generateKey();
  try {
    userKey = await unwrapKey(stretchedKey, keys.protectedUserKey, aad.userKey(keys.userId)).catch(
      () => {
        throw new Error("Master password is incorrect");
      },
    );
    const protectedVaultKey = await wrapKey(userKey, fresh, aad.vaultKey(keys.vaultId));
    await post("/vault/rotation/start", { authKey, protectedVaultKey });
    started = true;
    await runRotation(current, fresh, onProgress);
  } catch (e) {
    wipe(fresh);
    if (started) {
      // Part of the vault may already be under the new key. Lock: the next
      // unlock picks the rotation up where it stopped.
      closeVault();
      useSession.setState({ status: "locked" });
    }
    throw e;
  } finally {
    wipe(userKey);
    wipe(stretchedKey);
  }
  // The extension's copy of the private key was wrapped by the old vault key.
  if (extensionPrivateKey) {
    const { userId, envelope } = extensionPrivateKey;
    const pkcs8 = await decryptBytes(current, envelope, handoffAad(userId)).catch(() => null);
    extensionPrivateKey = pkcs8
      ? { userId, envelope: await encryptBytes(fresh, pkcs8, handoffAad(userId)) }
      : null;
    pkcs8?.fill(0);
  }
  wipe(vaultKey);
  vaultKey = fresh;
  // Cached ciphertext is under the old key.
  queryClient.clear();
}

function closeVault() {
  wipe(vaultKey);
  vaultKey = null;
  sharing = null;
  extensionPrivateKey = null;
  for (const l of closeListeners) l();
  wipe(pendingStretchedKey);
  pendingStretchedKey = null;
  // Cached responses include ciphertext and metadata; drop them on lock.
  queryClient.clear();
}

/** After the second factor, the master password from step one opens the vault. */
async function openAfterSecondFactor(result: AuthResult) {
  if (!pendingStretchedKey) return;
  try {
    await openVault(pendingStretchedKey, result.keys!);
  } finally {
    wipe(pendingStretchedKey);
    pendingStretchedKey = null;
  }
}

export const useSession = create<SessionState>((set, getState) => ({
  status: "loading",
  me: null,
  twoFactorMethods: [],

  async refresh() {
    try {
      const me = await get<MeResponse>("/auth/me");
      // The server may still consider the vault unlocked, but without the key
      // in memory (e.g. after a reload) this client is locked.
      set({ me, status: vaultKey && me.session.vaultUnlocked ? "unlocked" : "locked" });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401)
        set({ me: null, status: pendingStretchedKey ? "two-factor" : "signed-out" });
      else throw e;
    }
  },

  async register({ email, name, password }) {
    const userId = crypto.randomUUID();
    const vaultId = crypto.randomUUID();
    const keys = await createAccountKeys(password, userId, vaultId);
    const result = await post<AuthResult>("/auth/register", {
      email,
      name,
      userId,
      vaultId,
      authKey: keys.authKey,
      kdf: keys.kdf,
      protectedUserKey: keys.protectedUserKey,
      protectedVaultKey: keys.protectedVaultKey,
      device: deviceInfo(),
    });
    if (result.token) {
      setBearerToken(result.token);
      rememberDesktopSession(result.token);
    }
    wipe(vaultKey);
    vaultKey = keys.vaultKey;
    try {
      await openSharing(keys.userKey, {
        userId,
        vaultId,
        kdf: keys.kdf,
        protectedUserKey: keys.protectedUserKey,
        protectedVaultKey: keys.protectedVaultKey,
      });
    } finally {
      wipe(keys.userKey);
    }
    await getState().refresh();
  },

  async login({ email, password }) {
    const { kdf } = await post<{ kdf: VaultKeys["kdf"] }>("/auth/prelogin", { email });
    const { authKey, stretchedKey } = await deriveMasterKeys(password, kdf);
    const result = await post<AuthResult>("/auth/login", { email, authKey, device: deviceInfo() });
    if (result.token) {
      setBearerToken(result.token);
      rememberDesktopSession(result.token);
    }
    if (result.status === "two_factor_required") {
      pendingStretchedKey = stretchedKey;
      set({ status: "two-factor", twoFactorMethods: result.methods ?? ["totp"] });
      return "two_factor_required";
    }
    try {
      await openVault(stretchedKey, result.keys!);
    } finally {
      wipe(stretchedKey);
    }
    await getState().refresh();
    return "ok";
  },

  async verifyTwoFactor(code) {
    await openAfterSecondFactor(await post<AuthResult>("/auth/2fa/verify", { code }));
    await getState().refresh();
  },

  async verifyPasskey() {
    // The browser shows its own passkey prompt; the private key never leaves the authenticator.
    const optionsJSON = await post<PublicKeyCredentialRequestOptionsJSON>(
      "/auth/passkeys/login/options",
    );
    const response = await startAuthentication({ optionsJSON });
    await openAfterSecondFactor(await post<AuthResult>("/auth/passkeys/login", { response }));
    await getState().refresh();
  },

  async unlock(password) {
    const { kdf } = await get<Pick<VaultKeys, "kdf">>("/vault/kdf");
    const { authKey, stretchedKey } = await deriveMasterKeys(password, kdf);
    try {
      // The server checks the password too, so a locked session cannot be
      // reopened by a client that skips the local check.
      const res = await post<{ keys: VaultKeys }>("/vault/unlock", { authKey });
      await openVault(stretchedKey, res.keys);
    } finally {
      wipe(stretchedKey);
    }
    await getState().refresh();
  },

  async lock(opts) {
    closeVault();
    set((s) => ({ status: s.status === "signed-out" ? s.status : "locked" }));
    if (!opts?.silent) await post("/vault/lock").catch(() => undefined);
  },

  async logout() {
    await post("/auth/logout").catch(() => undefined);
    closeVault();
    setBearerToken(null);
    forgetDesktopSession();
    set({ status: "signed-out", me: null });
  },

  async emergencyLock() {
    await post("/vault/emergency-lock");
    closeVault();
    setBearerToken(null);
    forgetDesktopSession();
    set({ status: "signed-out", me: null });
  },

  setSettings(settings) {
    const me = getState().me;
    if (me) set({ me: { ...me, user: { ...me.user, ...settings } } });
  },
}));

onApiError((error) => {
  const { status } = useSession.getState();
  if (error.status === 401 && status !== "signed-out" && status !== "two-factor") {
    closeVault();
    setBearerToken(null);
    forgetDesktopSession();
    useSession.setState({ status: "signed-out", me: null });
  } else if (error.code === "VAULT_LOCKED" && status === "unlocked") {
    closeVault();
    useSession.setState({ status: "locked" });
  }
});

export async function revokeSession(id: string) {
  await del(`/sessions/${id}`);
}
