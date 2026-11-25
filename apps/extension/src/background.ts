/**
 * The extension's only privileged context.
 *
 * - The vault key lives in chrome.storage.session, which is held in memory,
 *   never written to disk, cleared when the browser closes, and (with
 *   TRUSTED_CONTEXTS) unreadable from content scripts. Only the session token
 *   and account email persist (persist.ts), so the extension stays signed in
 *   and a browser restart means unlocking, not signing in again.
 * - "Sign in with Minions app": the web app, unlocked in this browser, hands
 *   the extension a session of its own and the vault key through the content
 *   script on the app's origin, so no password is typed here at all.
 * - The vault is never downloaded: only items matching the current site's
 *   host are listed, and a secret is decrypted only for the one fill or copy
 *   the user asked for.
 * - The extension locks on its own timer, independent of the web app.
 */
import {
  type AuthResult,
  aad,
  analyzeCapture,
  canFill,
  DEFAULT_PASSWORD_OPTIONS,
  decryptString,
  deriveMasterKeys,
  encryptString,
  equivalentDomains,
  estimateStrength,
  fromBase64,
  generatePassword,
  generateTotp,
  getItemType,
  type ItemField,
  type ItemTypeDef,
  importPrivateKey,
  keyAad,
  type MeResponse,
  normalizeHost,
  openSealedKey,
  type Page,
  type PasswordOptions,
  registrableDomain,
  type SharedItemDetail,
  type SharedWithMeItem,
  sealContext,
  secretFingerprint,
  siteKeywords,
  toBase64,
  type UpsertItemRequest,
  unwrapKey,
  unwrapPrivateKeyBytes,
  type VaultItemDetail,
  type VaultItemSummary,
  type VaultKeys,
  type WorkspaceDetail,
  type WorkspaceItemDetail,
} from "@minions/core";
import {
  type BridgeHello,
  type FillMessage,
  type InlineItem,
  type InlineMatch,
  type ItemView,
  isValidRequest,
  type ListedItem,
  type MatchResponse,
  type PendingSave,
  type Request,
  type Response,
  type Settings,
  type StateResponse,
  type Status,
  type TotpEntry,
} from "./messages";
import { persisted, remembered } from "./persist";

declare const __API_URL__: string;
declare const __WEB_URL__: string;

const LOCK_ALARM = "minions-autolock";
const CLIPBOARD_ALARM = "minions-clipboard";
/** A detected login waits this long for the user's answer, then is dropped. */
const PENDING_TTL_MS = 5 * 60_000;
/** How long a "Sign in with Minions app" request, and each link nonce, stays valid. */
const CONNECT_TTL_MS = 10 * 60_000;
const WEB_ORIGIN = new URL(__WEB_URL__).origin;
const NEVER_SAVE_LIMIT = 500;
/** Input on the computer within this many seconds counts as the user being here. */
const ACTIVE_WITHIN_SECONDS = 60;
/** A gap this long between lock checks means the computer slept: that time counts as idle. */
const SLEPT_AFTER_MS = 3 * 60_000;
/** How long a username from step one of a two-step sign-in is kept for the password step. */
const USERNAME_TTL_MS = 5 * 60_000;
/** How long a save can be undone from the page. */
const UNDO_TTL_MS = 2 * 60_000;

interface SessionData {
  token?: string;
  email?: string;
  name?: string;
  status?: Status;
  vaultKey?: string;
  /** Sharing private key (PKCS#8), for workspace credentials. Memory-only, like the vault key. */
  privateKey?: string;
  userId?: string;
  /** The personal vault's id: the AAD of item keys wrapped by the vault key. */
  vaultId?: string;
  stretchedKey?: string;
  autoLockMinutes?: number;
  lastActivity?: number;
  /** When the auto-lock check last ran, to notice the computer sleeping. */
  lastTick?: number;
  pending?: PendingSave & { password: string; createdAt: number };
  /** The last save or update, for a minute or two, so the page's toast can undo it. */
  lastSaved?: {
    id: string;
    host: string;
    action: "saved" | "updated";
    itemId: string;
    workspaceId?: string;
    shared?: boolean;
    /** The fields as they were before an update (ciphertext as stored). */
    previous?: ItemField[];
    at: number;
  };
  /** Step one of a two-step sign-in on this host (memory only, never a password). */
  recentUsername?: { host: string; username: string; at: number };
  /** The user asked to sign in through the web app; it may ask them to approve until then. */
  wantsConnectUntil?: number;
  /** One-time nonces handed to the web app; a link must carry one. */
  bridgeNonces?: { n: string; at: number }[];
}

void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

const session = {
  async get(): Promise<SessionData> {
    return (await chrome.storage.session.get(null)) as SessionData;
  },
  async set(data: Partial<SessionData>) {
    await chrome.storage.session.set(data);
  },
  async clear(keys: (keyof SessionData)[]) {
    await chrome.storage.session.remove(keys);
  },
};

/**
 * The session token, restored from disk after a browser restart. A restored
 * session starts locked: the vault key never persists.
 */
async function currentToken(): Promise<string | undefined> {
  const s = await session.get();
  if (s.token || s.status === "two-factor") return s.token;
  const saved = await persisted.get();
  if (!saved) return undefined;
  await session.set({
    token: saved.token,
    email: saved.email,
    name: saved.name,
    userId: saved.userId,
    status: "locked",
  });
  await reopenRemembered();
  return saved.token;
}

let reopening: Promise<void> | null = null;

/**
 * "Remember on this computer": after a browser restart, open again from the
 * keys kept on this computer, as long as the server still has this session
 * unlocked. If the server has locked it, the master password is needed (and
 * the kept keys are dropped).
 */
function reopenRemembered(): Promise<void> {
  reopening ??= (async () => {
    const s = await session.get();
    if (s.status !== "locked" || !s.token) return;
    if (!(await settings()).rememberDevice) return;
    const kept = await remembered.load();
    if (!kept || kept.userId !== s.userId) return;
    const me = await api<MeResponse>("/auth/me", { token: s.token }).catch(() => null);
    if (!me) return; // Offline: try again later.
    if (!me.session.vaultUnlocked || me.user.id !== kept.userId || me.vaultId !== kept.vaultId) {
      await remembered.clear();
      return;
    }
    await session.set({
      vaultKey: kept.vaultKey,
      ...(kept.privateKey ? { privateKey: kept.privateKey } : {}),
      vaultId: kept.vaultId,
      status: "unlocked",
      autoLockMinutes: me.user.autoLockMinutes,
      email: me.user.email,
      name: me.user.name,
      lastActivity: Date.now(),
    });
    await scheduleLock();
    stateChanged();
  })().finally(() => {
    reopening = null;
  });
  return reopening;
}

/** Keeps (or drops) this computer's copy of the keys, per the user's setting. */
async function rememberIfWanted() {
  const s = await session.get();
  if (!(await settings()).rememberDevice || s.status !== "unlocked") return;
  if (!s.userId || !s.vaultId || !s.vaultKey) return;
  await remembered
    .save({
      userId: s.userId,
      vaultId: s.vaultId,
      vaultKey: s.vaultKey,
      privateKey: s.privateKey ?? null,
    })
    .catch(() => undefined);
}

/** Remembers the signed-in account across restarts (never a key). */
async function persistSignIn() {
  const s = await session.get();
  if (!s.token || !s.userId || !s.email) return;
  await persisted.set({ token: s.token, email: s.email, userId: s.userId, name: s.name });
}

async function api<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    query?: Record<string, string>;
    /** Another session's token (checking or ending one); its failures never sign this one out. */
    token?: string;
  } = {},
): Promise<T> {
  const token = init.token ?? (await currentToken());
  // Appended, not resolved: new URL("/auth/me", "https://host/api") would drop
  // the /api prefix and reach the web app instead of the API.
  const url = new URL(`${__API_URL__}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      "x-minions-client": "extension",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "omit",
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as {
    message?: string | string[];
    code?: string;
  } | null;
  if (res.status === 401 && !init.token) {
    await signOutLocally();
    throw new Error("Signed out. Sign in again.");
  }
  if (data?.code === "VAULT_LOCKED" && !init.token) {
    await lockLocally();
    throw new Error("Vault locked");
  }
  if (!res.ok)
    throw new Error(
      Array.isArray(data?.message)
        ? data.message[0]
        : (data?.message ?? `Request failed (${res.status})`),
    );
  // A page instead of an API answer: the extension was built for the wrong address.
  if (res.headers.get("content-type")?.includes("text/html"))
    throw new Error(`No answer from the Minions API at ${__API_URL__}`);
  return data as T;
}

async function deviceInfo() {
  const stored = (await chrome.storage.local.get("deviceId")) as { deviceId?: string };
  let id = stored.deviceId;
  if (!id) {
    id = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId: id });
  }
  const os = navigator.userAgent.includes("Windows")
    ? "Windows"
    : navigator.userAgent.includes("Mac")
      ? "macOS"
      : "Linux";
  return { clientDeviceId: id, name: `Chrome extension on ${os}`, kind: "extension" as const };
}

async function vaultKey(): Promise<Uint8Array<ArrayBuffer>> {
  const { vaultKey: k, status } = await session.get();
  if (!k || status !== "unlocked") throw new Error("Vault locked");
  return fromBase64(k);
}

async function openVault(stretchedKey: Uint8Array<ArrayBuffer>, keys: VaultKeys) {
  // Mid-rotation, part of the vault is under each key. The web app finishes it;
  // the popup is too short-lived to re-encrypt a whole vault.
  if (keys.pendingProtectedVaultKey) {
    await api("/vault/lock", { method: "POST" }).catch(() => undefined);
    throw new Error("Your vault key is being changed. Open the Minions web app to finish it.");
  }
  const userKey = await unwrapKey(stretchedKey, keys.protectedUserKey, aad.userKey(keys.userId));
  const vk = await unwrapKey(userKey, keys.protectedVaultKey, aad.vaultKey(keys.vaultId));
  // The web app creates the sharing key pair on first unlock; until then there are no team logins.
  const pk = keys.protectedPrivateKey
    ? await unwrapPrivateKeyBytes(userKey, keys.protectedPrivateKey, keys.userId).catch(() => null)
    : null;
  userKey.fill(0);
  const me = await api<MeResponse>("/auth/me");
  await session.set({
    ...(pk ? { privateKey: toBase64(pk) } : {}),
    userId: keys.userId,
    vaultKey: toBase64(vk),
    vaultId: keys.vaultId,
    status: "unlocked",
    autoLockMinutes: me.user.autoLockMinutes,
    email: me.user.email,
    name: me.user.name,
    lastActivity: Date.now(),
  });
  vk.fill(0);
  pk?.fill(0);
  await persistSignIn();
  await scheduleLock();
  await rememberIfWanted();
  // An app tab that is locked can open from here now.
  for (const t of await appTabs()) if (t.id !== undefined) await pingApp(t.id);
}

async function lockLocally() {
  // Locked means locked on this computer too: the next start asks again.
  await remembered.clear();
  await session.clear(["vaultKey", "privateKey", "stretchedKey", "pending", "recentUsername"]);
  const { token } = await session.get();
  await session.set({ status: token ? "locked" : "signed-out" });
  await chrome.alarms.clear(LOCK_ALARM);
  await chrome.action.setBadgeText({ text: "" });
}

async function signOutLocally() {
  await persisted.clear();
  await remembered.clear();
  await chrome.storage.session.clear();
  await session.set({ status: "signed-out" });
  await chrome.alarms.clear(LOCK_ALARM);
}

async function scheduleLock() {
  await session.set({ lastTick: Date.now() });
  await chrome.alarms.create(LOCK_ALARM, { periodInMinutes: 1 });
}

/**
 * Auto-lock after the user's idle time, where idle means away from the
 * computer, not merely not using this popup: someone browsing and signing in
 * to sites stays unlocked. While they are active the server's unlock window
 * is kept in step, or it would lock the session on its own. "Immediately" (0)
 * still means a minute after the popup was last used. Time the computer
 * spent asleep counts as idle, however active the user is on waking.
 */
async function checkAutoLock() {
  const s = await session.get();
  if (s.status !== "unlocked") {
    await chrome.alarms.clear(LOCK_ALARM);
    return;
  }
  const now = Date.now();
  const minutes = s.autoLockMinutes ?? 15;
  // "Stay unlocked while the browser is open" (the default): no idle lock, and
  // the server's unlock window is kept open for as long as the browser runs.
  // The vault key still lives in memory only, so closing the browser locks.
  const prefs = await settings();
  if (minutes > 0 && (prefs.lockMode !== "idle" || prefs.rememberDevice)) {
    await session.set({ lastTick: now, lastActivity: now });
    await api("/vault/heartbeat", { method: "POST" }).catch(() => undefined);
    return;
  }
  const awake = now - (s.lastTick ?? now) < SLEPT_AFTER_MS;
  let last = s.lastActivity ?? 0;
  const active =
    minutes > 0 && awake && (await chrome.idle.queryState(ACTIVE_WITHIN_SECONDS)) === "active";
  if (active) last = now;
  await session.set({ lastTick: now, lastActivity: last });
  if (now - last > Math.max(minutes, 1) * 60_000) {
    await api("/vault/lock", { method: "POST" }).catch(() => undefined);
    await lockLocally();
    return;
  }
  if (active) await api("/vault/heartbeat", { method: "POST" }).catch(() => undefined);
}

/**
 * Chrome does not put a freshly installed or reloaded extension's content
 * script into tabs that are already open. The Minions app's tabs need it to
 * unlock this extension, so it is added to them here (the only site this
 * extension has access to).
 */
chrome.runtime.onInstalled.addListener(async () => {
  for (const t of await appTabs()) {
    if (t.id === undefined) continue;
    // A tab that already has a live copy (it loaded after the install) keeps
    // just that one: two would both answer the app.
    const live = await chrome.tabs
      .sendMessage(t.id, { type: "minions-alive" }, { frameId: 0 })
      .catch(() => false);
    if (live === true) continue;
    await chrome.scripting
      .executeScript({ target: { tabId: t.id }, files: ["content.js"] })
      .catch(() => undefined);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CLIPBOARD_ALARM) {
    await clearClipboard().catch(() => undefined);
    return;
  }
  if (alarm.name === LOCK_ALARM) await checkAutoLock();
});

async function getStatus(): Promise<Status> {
  const token = await currentToken();
  const s = await session.get();
  if (!token) return s.status === "two-factor" ? "two-factor" : "signed-out";
  return s.status ?? "locked";
}

// ─── One-time nonces for the app bridge ──────────────────────────────────────
// Read, changed and written back in turn: two hellos at once must not each
// write their own list over the other's (a nonce would vanish and the app's
// next request be refused as expired).

/** Runs calls one after another, each after the last has finished. */
function queue() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = last.then(fn, fn);
    last = run.catch(() => undefined);
    return run;
  };
}
const inTurn = queue();
/** Links from the app, one at a time: two at once could revoke each other's session. */
const linkInTurn = queue();

function issueNonce(): Promise<string> {
  return inTurn(async () => {
    const now = Date.now();
    const nonce = crypto.randomUUID();
    const { bridgeNonces = [] } = await session.get();
    const kept = bridgeNonces.filter((x) => now - x.at < CONNECT_TTL_MS).slice(-7);
    await session.set({ bridgeNonces: [...kept, { n: nonce, at: now }] });
    return nonce;
  });
}

/** Uses up a nonce; false if it was never given out, already used, or too old. */
function takeNonce(n: string): Promise<boolean> {
  return inTurn(async () => {
    const now = Date.now();
    const { bridgeNonces = [] } = await session.get();
    const hit = bridgeNonces.find((x) => x.n === n && now - x.at < CONNECT_TTL_MS);
    if (!hit) return false;
    await session.set({ bridgeNonces: bridgeNonces.filter((x) => x !== hit) });
    return true;
  });
}

/** Ends another session (a replaced one, or one the web app minted that is not needed). */
async function revokeToken(token: string) {
  await api("/auth/logout", { method: "POST", token }).catch(() => undefined);
}

/** Ends a session the app offered and we are not taking, unless it is the one in use. */
async function discardOffered(token: string) {
  if ((await session.get()).token !== token) await revokeToken(token);
}

/** Tells an open popup to redraw; nothing is listening when it is closed. */
function stateChanged() {
  chrome.runtime.sendMessage({ type: "minions-state-changed" }).catch(() => undefined);
}

/** Open tabs of the Minions web app, the one in front first. */
async function appTabs() {
  const tabs = await chrome.tabs.query({ url: `${WEB_ORIGIN}/*` });
  return tabs.sort((a, b) => Number(b.active) - Number(a.active));
}

/** Asks the app in a tab to say hello again (and so to connect, if it is unlocked). */
async function pingApp(tabId: number) {
  await chrome.tabs
    .sendMessage(tabId, { type: "minions-bridge-hello" }, { frameId: 0 })
    .catch(() => undefined);
}

interface TotpRow {
  id: string;
  name: string;
  subtitle: string | null;
  favorite: boolean;
  protectedItemKey: string | null;
  field: ItemField;
}

function fieldLabel(def: ItemTypeDef | undefined, f: ItemField) {
  return f.label ?? def?.fields.find((d) => d.key === f.key)?.label ?? f.key;
}

/** An item with the key that opens its fields: the vault key, or a workspace item's own key. */
interface OpenedItem {
  item: VaultItemDetail;
  key: Uint8Array<ArrayBuffer>;
  workspaceId?: string;
  permission?: "VIEW" | "MANAGE";
  /** Someone else's item, shared with this user. */
  shared?: boolean;
}

function itemPath(id: string, workspaceId?: string, shared?: boolean) {
  if (shared) return `/shared/items/${id}`;
  return workspaceId ? `/workspaces/${workspaceId}/items/${id}` : `/vault/items/${id}`;
}

/** Items shared with the user, in the popup's list shape. */
function listShared(rows: SharedWithMeItem[]): ListedItem[] {
  return rows.map(({ permission, sharedBy, ...r }) => ({
    ...r,
    shared: true,
    sharedBy: sharedBy.name,
    sharedPermission: permission,
  }));
}

async function sharingKey() {
  const { privateKey, userId, status } = await session.get();
  if (status !== "unlocked") throw new Error("Vault locked");
  if (!privateKey || !userId)
    throw new Error("Open the Minions web app once, then lock and unlock here to use team logins");
  return { privateKey: await importPrivateKey(fromBase64(privateKey)), userId };
}

/**
 * Fetches one item and opens its key. The server decides whether this user
 * may have it; the workspace id only says which route to ask.
 */
async function openItem(id: string, workspaceId?: string, shared?: boolean): Promise<OpenedItem> {
  if (shared) {
    // Shared with this user: the item key is sealed to their public key.
    const item = await api<SharedItemDetail>(itemPath(id, undefined, true));
    const { privateKey, userId } = await sharingKey();
    const key = await openSealedKey(
      privateKey,
      item.sealedItemKey,
      sealContext.itemKey(id, userId),
    );
    return { item, key, shared: true };
  }
  if (!workspaceId) {
    const item = await api<VaultItemDetail>(itemPath(id));
    const vk = await vaultKey();
    if (!item.protectedItemKey) return { item, key: vk };
    // Shared with people: the item has its own key, wrapped by the vault key.
    const vaultId = (await session.get()).vaultId ?? (await api<MeResponse>("/auth/me")).vaultId;
    const key = await unwrapKey(vk, item.protectedItemKey, keyAad.itemKeyForVault(vaultId, id));
    vk.fill(0);
    return { item, key };
  }
  const item = await api<WorkspaceItemDetail>(itemPath(id, workspaceId));
  const { privateKey, userId } = await sharingKey();
  let key: Uint8Array<ArrayBuffer>;
  if (item.key.source === "grant") {
    key = await openSealedKey(privateKey, item.key.wrapped, sealContext.itemKey(id, userId));
  } else {
    const ws = await api<WorkspaceDetail>(`/workspaces/${workspaceId}`);
    if (!ws.protectedWorkspaceKey)
      throw new Error("Your workspace membership is not confirmed yet");
    const wsKey = await openSealedKey(
      privateKey,
      ws.protectedWorkspaceKey,
      sealContext.workspaceKey(workspaceId, userId),
    );
    key = await unwrapKey(wsKey, item.key.wrapped, keyAad.itemKeyForWorkspace(workspaceId, id));
    wsKey.fill(0);
  }
  return { item, key, workspaceId, permission: item.permission };
}

async function decryptField(o: OpenedItem, key: string): Promise<string | null> {
  const f = o.item.fields.find((x) => x.key === key);
  if (!f) return null;
  return f.sensitive ? decryptString(o.key, f.value, aad.field(o.item.id, key)) : f.value;
}

async function recordUsage(o: OpenedItem, action: string, field?: string) {
  await api(`${itemPath(o.item.id, o.workspaceId, o.shared)}/usage`, {
    method: "POST",
    body: { action, field },
  }).catch(() => undefined);
}

/** Personal and workspace logins for a host. Workspace ones are skipped if unavailable. */
async function matchOne(host: string): Promise<ListedItem[]> {
  const [mine, team, shared] = await Promise.all([
    api<VaultItemSummary[]>("/vault/items/match", { query: { host } }),
    api<ListedItem[]>("/workspaces/items/match", { query: { host } }).catch(() => []),
    api<SharedWithMeItem[]>("/shared/match", { query: { host } }).catch(() => []),
  ]);
  return [...mine, ...team, ...listShared(shared)];
}

/**
 * Logins for a host, including the other domains of the same sign-in system
 * (a gmail.com login on accounts.google.com). The page's own site first.
 */
async function matchAll(host: string): Promise<ListedItem[]> {
  const domain = registrableDomain(host);
  const others = equivalentDomains(domain).filter((d) => d !== domain);
  const lists = await Promise.all([
    matchOne(host),
    ...others.map((d) => matchOne(d).catch(() => [] as ListedItem[])),
  ]);
  const seen = new Set<string>();
  return lists.flat().filter((i) => !seen.has(i.id) && !!seen.add(i.id));
}

/**
 * Personal logins saved without a website whose name points at this site
 * ("Gmail", "GSuite access" on accounts.google.com). Offered, never filled
 * without the user confirming; filling one remembers the site on it.
 */
async function unlinkedFor(host: string): Promise<ListedItem[]> {
  const words = siteKeywords(host);
  const pages = await Promise.all(
    words.map((q) =>
      api<Page<VaultItemSummary>>("/vault/items", { query: { q, limit: "10" } })
        .then((p) => p.items)
        .catch(() => [] as VaultItemSummary[]),
    ),
  );
  const seen = new Set<string>();
  return pages
    .flat()
    .filter((i) => !i.host && isFillable(i) && !seen.has(i.id) && !!seen.add(i.id))
    .slice(0, 8);
}

/** Something with a password to fill: logins, and anything else whose password is scored. */
const isFillable = (i: ListedItem) => i.type === "LOGIN" || i.passwordStrength !== null;

/**
 * Fills one item into a tab's top frame, after checking the tab's address
 * (as the browser reports it) is the item's site.
 */
async function fillTab(
  tabId: number,
  ref: { itemId: string; workspaceId?: string; shared?: boolean },
  /** The user confirmed filling a login saved without a website here: remember the site on it. */
  link = false,
  /**
   * The page's address as the browser reported it with the request (a content
   * script's sender.url). Asked from a page, the extension may not read the
   * tab's address itself: it has no access to most sites until the toolbar
   * button is clicked.
   */
  senderUrl?: string,
) {
  const pageUrl = senderUrl ?? (await chrome.tabs.get(tabId)).url ?? "";
  if (!pageUrl) throw new Error("Open Minions from the toolbar to fill this page");
  const host = normalizeHost(pageUrl);
  const opened = await openItem(ref.itemId, ref.workspaceId, ref.shared);
  const { item } = opened;
  const savedUrl = item.fields.find((f) => f.key === "url" && !f.sensitive)?.value ?? null;
  // Only fill a page whose site matches the item (public-suffix aware,
  // compared in punycode), and never an https login into an http page.
  // A look-alike or phishing domain gets nothing.
  // A login with no website at all may be filled only when the user picked it
  // and confirmed it for this page; one saved for another site never is.
  const unlinked = link && !item.host && !savedUrl && !ref.workspaceId && !ref.shared;
  if (!unlinked && !canFill(savedUrl, item.host, pageUrl)) {
    opened.key.fill(0);
    throw new Error(`This login is for ${item.host ?? "another site"}, not ${host ?? "this page"}`);
  }
  if (unlinked && !/^https:/.test(pageUrl) && host !== "localhost" && host !== "127.0.0.1") {
    opened.key.fill(0);
    throw new Error("Minions fills a login saved without a website on secure (https) pages only");
  }
  const username =
    (await decryptField(opened, "username")) ?? (await decryptField(opened, "email")) ?? "";
  const password = (await decryptField(opened, "password")) ?? "";
  if (unlinked) {
    // Remembered on the login, so the next visit finds it like any other.
    const url = { key: "url", value: new URL(pageUrl).origin, sensitive: false };
    await writeItem(opened, [...storedFields(item), url], password).catch(() => undefined);
  }
  opened.key.fill(0);
  const msg: FillMessage = {
    type: "minions-fill",
    origin: new URL(pageUrl).origin,
    username,
    password,
  };
  // Top frame only: an embedded, possibly cross-origin iframe never receives credentials.
  const res = (await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 })) as
    | { filled?: boolean }
    | undefined;
  if (!res?.filled) throw new Error("No login form found on this page");
  await recordUsage(opened, "item.autofilled");
}

/** The stored fields of an item, ready to send back (ciphertext untouched). */
function storedFields(item: VaultItemDetail): ItemField[] {
  return item.fields.map((f) => ({
    key: f.key,
    value: f.value,
    sensitive: f.sensitive,
    ...(f.label ? { label: f.label, kind: f.kind } : {}),
  }));
}

/** Saves an item's fields as given, keeping everything else about it. */
async function writeItem(o: OpenedItem, fields: ItemField[], password: string) {
  const { item } = o;
  // Workspace and shared items: no personal projects, no reuse fingerprint.
  const team = !!o.workspaceId || !!o.shared;
  await api(itemPath(item.id, o.workspaceId, o.shared), {
    method: "PUT",
    body: {
      id: item.id,
      type: item.type,
      name: item.name,
      description: item.description,
      projectId: team ? null : (item.project?.id ?? null),
      collectionId: item.collection?.id ?? null,
      favorite: item.favorite,
      tags: item.tags,
      usedByProjectIds: team ? [] : item.usedBy.map((p) => p.id),
      fields,
      revision: item.revision,
      signals: {
        passwordStrength: estimateStrength(password).score,
        // Reuse detection compares personal passwords only.
        ...(team
          ? {}
          : { passwordFingerprint: await secretFingerprint(await vaultKey(), password) }),
      },
    },
  });
}

async function buildLogin(
  host: string,
  url: string,
  username: string,
  password: string,
): Promise<UpsertItemRequest> {
  const key = await vaultKey();
  const id = crypto.randomUUID();
  const isEmail = username.includes("@");
  const fields: ItemField[] = [
    { key: "url", value: url, sensitive: false },
    ...(username
      ? [{ key: isEmail ? "email" : "username", value: username, sensitive: false }]
      : []),
    {
      key: "password",
      value: await encryptString(key, password, aad.field(id, "password")),
      sensitive: true,
    },
  ];
  const name =
    host
      .replace(/^www\./, "")
      .split(".")
      .slice(-2, -1)[0] ?? host;
  return {
    id,
    type: "LOGIN",
    name: name.charAt(0).toUpperCase() + name.slice(1),
    fields,
    signals: {
      passwordStrength: estimateStrength(password).score,
      passwordFingerprint: await secretFingerprint(key, password),
    },
  };
}

// ─── Clipboard ───────────────────────────────────────────────────────────────
// The popup writes the secret and closes; clearing it is the background's job,
// done from an offscreen document because a service worker has no clipboard.

const CLIPBOARD_CLEAR_SECONDS = 30;

async function scheduleClipboardClear() {
  // 0.5 minutes is the shortest alarm Chrome allows, and it survives the worker sleeping.
  await chrome.alarms.create(CLIPBOARD_ALARM, { delayInMinutes: CLIPBOARD_CLEAR_SECONDS / 60 });
}

async function clearClipboard() {
  const url = chrome.runtime.getURL("offscreen.html");
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (!existing.length)
    await chrome.offscreen.createDocument({
      url,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: "Clear a copied password from the clipboard",
    });
  await chrome.runtime.sendMessage({ target: "offscreen", type: "clear-clipboard" });
  await chrome.offscreen.closeDocument().catch(() => undefined);
}

// ─── "Never for this site" ───────────────────────────────────────────────────
// Only hostnames are kept, in local storage; never usernames or passwords.

async function neverSaveHosts(): Promise<string[]> {
  const { neverSave } = (await chrome.storage.local.get("neverSave")) as { neverSave?: string[] };
  return Array.isArray(neverSave) ? neverSave : [];
}

async function addNeverSave(host: string) {
  const hosts = (await neverSaveHosts()).filter((h) => h !== host);
  hosts.push(host);
  await chrome.storage.local.set({ neverSave: hosts.slice(-NEVER_SAVE_LIMIT) });
}

// ─── Preferences ─────────────────────────────────────────────────────────────
// Kept in local storage: an email and on/off switches, never a secret.

async function settings(): Promise<Settings> {
  const { settings: s } = (await chrome.storage.local.get("settings")) as { settings?: Settings };
  return s && typeof s === "object" ? s : {};
}

/** The popup's generator settings, so a password made on a page matches one made there. */
async function generatorOptions(): Promise<PasswordOptions> {
  const { generator } = (await chrome.storage.local.get("generator")) as {
    generator?: Partial<PasswordOptions>;
  };
  const o = { ...DEFAULT_PASSWORD_OPTIONS, ...(generator ?? {}) };
  // A password made for a sign-up form is never short, whatever the slider says.
  return { ...o, length: Math.max(o.length, 16) };
}

/** The pending login, unless it has waited too long for an answer. */
async function currentPending(): Promise<SessionData["pending"] | null> {
  const { pending } = await session.get();
  if (!pending) return null;
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    await session.clear(["pending"]);
    await chrome.action.setBadgeText({ text: "" });
    return null;
  }
  return pending;
}

async function handle(req: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Only the extension's own pages are trusted. Anything else is a content
  // script on a web page, which may only report submissions and ask about or
  // answer its own pending save, and only from the top frame.
  if (sender.id !== chrome.runtime.id) throw new Error("Not allowed");
  if (!isValidRequest(req)) throw new Error("Not allowed");
  const fromContent = !sender.url?.startsWith(chrome.runtime.getURL(""));
  if (fromContent) {
    if (sender.frameId !== 0 || !sender.tab) throw new Error("Not allowed");
    // The app bridge answers the Minions web app's own origin only, as the
    // browser reports it: any other site asking gets nothing.
    let origin: string | null = null;
    try {
      origin = new URL(sender.url ?? "").origin;
    } catch {
      /* not a page */
    }
    const appOnly = ["bridgeHello", "bridgeLink", "bridgeUnlockApp", "bridgeLock"];
    const allowed = [
      "formSubmitted",
      "pendingSave",
      "resolveSave",
      "inlineMatch",
      "inlineFill",
      "inlineGenerate",
      "inlineTotp",
      "undoSave",
      "usernameSeen",
      "openPopup",
    ];
    if (origin === WEB_ORIGIN) allowed.push(...appOnly);
    if (!allowed.includes(req.type)) throw new Error("Not allowed");
  } else await session.set({ lastActivity: Date.now() });
  // For content scripts: the page's host as the browser reports it, never as the page claims.
  const senderHost = fromContent ? normalizeHost(sender.url ?? null) : null;

  switch (req.type) {
    case "state": {
      if ((await getStatus()) === "locked") await reopenRemembered();
      const s = await session.get();
      const status = await getStatus();
      const s2 = await session.get();
      return {
        status,
        email: s2.email ?? s.email ?? null,
        name: s2.name ?? null,
        linked: status === "locked" || status === "unlocked",
        apiUrl: __API_URL__,
        webUrl: __WEB_URL__,
      } satisfies StateResponse;
    }
    case "activity":
      return null;
    case "rememberDevice":
      // The popup changed the switch: keep the keys now, or drop them.
      if (req.on) await rememberIfWanted();
      else await remembered.clear();
      return null;
    case "login": {
      const { kdf } = await api<{ kdf: VaultKeys["kdf"] }>("/auth/prelogin", {
        body: { email: req.email },
      });
      const { authKey, stretchedKey } = await deriveMasterKeys(req.password, kdf);
      const result = await api<AuthResult>("/auth/login", {
        body: { email: req.email, authKey, device: await deviceInfo() },
      });
      await session.set({ token: result.token, email: req.email, wantsConnectUntil: 0 });
      if (result.status === "two_factor_required") {
        // Held in memory-only session storage until the code is entered.
        await session.set({ status: "two-factor", stretchedKey: toBase64(stretchedKey) });
        stretchedKey.fill(0);
        return "two-factor";
      }
      await openVault(stretchedKey, result.keys!);
      stretchedKey.fill(0);
      return "unlocked";
    }
    case "verify2fa": {
      const result = await api<AuthResult>("/auth/2fa/verify", { body: { code: req.code } });
      const { stretchedKey } = await session.get();
      if (!stretchedKey) throw new Error("Sign in again");
      await openVault(fromBase64(stretchedKey), result.keys!);
      await session.clear(["stretchedKey"]);
      return "unlocked";
    }
    case "unlock": {
      const { kdf } = await api<Pick<VaultKeys, "kdf">>("/vault/kdf");
      const { authKey, stretchedKey } = await deriveMasterKeys(req.password, kdf);
      const res = await api<{ keys: VaultKeys }>("/vault/unlock", { body: { authKey } });
      await openVault(stretchedKey, res.keys);
      stretchedKey.fill(0);
      return "unlocked";
    }
    case "lock":
      await api("/vault/lock", { method: "POST" }).catch(() => undefined);
      await lockLocally();
      return null;
    case "logout":
      await api("/auth/logout", { method: "POST" }).catch(() => undefined);
      await signOutLocally();
      return null;
    case "match": {
      const tab = await chrome.tabs.get(req.tabId);
      const host = normalizeHost(tab.url ?? null);
      if (!host) return { host: null, items: [] } satisfies MatchResponse;
      await vaultKey();
      return { host, items: await matchAll(host) } satisfies MatchResponse;
    }
    case "browse": {
      await vaultKey();
      const page = await api<Page<VaultItemSummary>>("/vault/items", {
        query:
          req.view === "favorites"
            ? { favorite: "true", sort: "name", limit: "20" }
            : { sort: "recent", limit: "6" },
      });
      // "Recent" means used here before, not merely created.
      return page.items.filter(
        (i) => req.view === "favorites" || i.lastAccessedAt,
      ) satisfies ListedItem[];
    }
    case "search": {
      await vaultKey();
      const [page, team, shared] = await Promise.all([
        api<Page<VaultItemSummary>>("/vault/items", { query: { q: req.q, limit: "10" } }),
        api<ListedItem[]>("/workspaces/items/search", { query: { q: req.q } }).catch(() => []),
        api<SharedWithMeItem[]>("/shared/search", { query: { q: req.q } }).catch(() => []),
      ]);
      return [...page.items, ...team, ...listShared(shared)] satisfies ListedItem[];
    }
    case "fill":
      await fillTab(req.tabId, req);
      return null;
    case "inlineMatch": {
      // The page's own site only, as the browser reports it.
      const status = await getStatus();
      const prefs = await settings();
      const base = {
        status,
        host: senderHost,
        items: [],
        suggested: [] as InlineItem[],
        emails: [] as string[],
      };
      if (prefs.inlineMenu === false) return { ...base, enabled: false } satisfies InlineMatch;
      const account =
        status === "locked" || status === "unlocked" ? (await session.get()).email : "";
      const emails = [
        ...new Set([prefs.signupEmail?.trim(), account].filter((e): e is string => !!e)),
      ];
      if (status !== "unlocked" || !senderHost)
        return { ...base, enabled: true, emails } satisfies InlineMatch;
      const items = (await matchAll(senderHost)).filter(isFillable).map(
        (i): InlineItem => ({
          id: i.id,
          name: i.name,
          username: i.username,
          badge: i.workspaceName ?? (i.sharedBy ? `from ${i.sharedBy}` : null),
          hasTotp: i.hasTotp,
          ...(i.workspaceId ? { workspaceId: i.workspaceId } : {}),
          ...(i.shared ? { shared: true } : {}),
        }),
      );
      // Nothing saved for this site: logins saved without a website that look like it.
      const suggested = items.length
        ? []
        : (await unlinkedFor(senderHost).catch(() => [] as ListedItem[])).map(
            (i): InlineItem => ({
              id: i.id,
              name: i.name,
              username: i.username,
              badge: null,
              hasTotp: i.hasTotp,
              unlinked: true,
            }),
          );
      return { ...base, enabled: true, emails, items, suggested } satisfies InlineMatch;
    }
    case "inlineGenerate":
      return generatePassword(await generatorOptions());
    case "inlineTotp": {
      // Only for a login of the page's own site, like a fill.
      const opened = await openItem(req.itemId, req.workspaceId, req.shared);
      const { item } = opened;
      const savedUrl = item.fields.find((f) => f.key === "url" && !f.sensitive)?.value ?? null;
      if (!canFill(savedUrl, item.host, sender.url ?? "")) {
        opened.key.fill(0);
        throw new Error(`This login is for ${item.host ?? "another site"}`);
      }
      const secret = await decryptField(opened, "totp");
      opened.key.fill(0);
      if (!secret) throw new Error("No 2FA secret on this login");
      // A code shown in the menu is not a use; filling it is.
      if (!req.peek) {
        await session.set({ lastActivity: Date.now() });
        await recordUsage(opened, "item.totp_generated");
      }
      const { code, remaining, period } = await generateTotp(secret);
      return { code, remaining, period };
    }
    case "inlineFill":
      // Into the tab that asked; fillTab still checks its address against the item.
      await session.set({ lastActivity: Date.now() });
      await fillTab(sender.tab!.id!, req, !!req.link, sender.url);
      return null;
    case "usernameSeen": {
      if ((await session.get()).status !== "unlocked" || !senderHost || !req.username) return null;
      await session.set({
        recentUsername: { host: senderHost, username: req.username, at: Date.now() },
      });
      return null;
    }
    case "openPopup":
      // Needs a focused browser window; the menu says where to click otherwise.
      await chrome.action.openPopup().catch(() => {
        throw new Error("Click the Minions icon in the toolbar to unlock");
      });
      return null;
    case "copy": {
      const opened = await openItem(req.itemId, req.workspaceId, req.shared);
      const value =
        (await decryptField(opened, req.field)) ??
        (req.field === "username" ? await decryptField(opened, "email") : null);
      opened.key.fill(0);
      if (value === null) throw new Error("Field not found");
      await recordUsage(opened, "item.copied", req.field);
      // The popup writes it to the clipboard; the clear is scheduled here.
      await scheduleClipboardClear();
      return value;
    }
    case "totp": {
      const opened = await openItem(req.itemId, req.workspaceId, req.shared);
      const secret = await decryptField(opened, "totp");
      opened.key.fill(0);
      if (!secret) throw new Error("No 2FA secret on this item");
      if (!req.quiet) await recordUsage(opened, "item.totp_generated");
      return generateTotp(secret);
    }
    case "totpList": {
      // Every personal 2FA code, live. Secrets are decrypted here, turned into
      // codes and dropped: only the codes go to the popup.
      const rows = await api<TotpRow[]>("/vault/items/totp");
      const vk = await vaultKey();
      const vaultId = (await session.get()).vaultId ?? (await api<MeResponse>("/auth/me")).vaultId;
      const now = Date.now();
      try {
        return await Promise.all(
          rows.map(async (r): Promise<TotpEntry> => {
            const base = { id: r.id, name: r.name, subtitle: r.subtitle, favorite: r.favorite };
            let key = vk;
            try {
              if (r.protectedItemKey)
                key = await unwrapKey(
                  vk,
                  r.protectedItemKey,
                  keyAad.itemKeyForVault(vaultId, r.id),
                );
              const secret = r.field.sensitive
                ? await decryptString(key, r.field.value, aad.field(r.id, "totp"))
                : r.field.value;
              const cur = await generateTotp(secret, now);
              const next = await generateTotp(secret, now + cur.period * 1000);
              return {
                ...base,
                code: cur.code,
                next: next.code,
                remaining: cur.remaining,
                period: cur.period,
              };
            } catch {
              return { ...base, code: null, next: null, remaining: 30, period: 30 };
            } finally {
              if (key !== vk) key.fill(0);
            }
          }),
        );
      } finally {
        vk.fill(0);
      }
    }
    case "item": {
      const opened = await openItem(req.itemId, req.workspaceId, req.shared);
      const { item } = opened;
      opened.key.fill(0);
      const def = getItemType(item.type);
      const url = item.fields.find((f) => f.key === "url" && !f.sensitive)?.value ?? null;
      let fillable = false;
      if (req.tabId !== undefined && item.fields.some((f) => f.key === "password")) {
        const tab = await chrome.tabs.get(req.tabId).catch(() => null);
        fillable = !!tab?.url && canFill(url, item.host, tab.url);
      }
      return {
        id: item.id,
        name: item.name,
        type: item.type,
        typeLabel: def?.label ?? item.type,
        host: item.host,
        url,
        favorite: item.favorite,
        hasTotp: item.fields.some((f) => f.key === "totp"),
        canFill: fillable,
        ...(opened.workspaceId ? { workspaceId: opened.workspaceId } : {}),
        ...(opened.shared ? { shared: true } : {}),
        fields: item.fields
          .filter((f) => f.key !== "totp")
          .map((f) => ({
            key: f.key,
            label: fieldLabel(def, f),
            sensitive: f.sensitive,
            kind: f.kind ?? def?.fields.find((d) => d.key === f.key)?.kind ?? "text",
            value: f.sensitive ? null : f.value,
          })),
      } satisfies ItemView;
    }
    case "reveal": {
      const opened = await openItem(req.itemId, req.workspaceId, req.shared);
      const value = await decryptField(opened, req.field);
      opened.key.fill(0);
      if (value === null) throw new Error("Field not found");
      await recordUsage(opened, "item.revealed", req.field);
      return value;
    }
    case "connect": {
      if (req.silent) {
        // The popup opened locked: an app tab that is unlocked reconnects us.
        for (const t of await appTabs()) if (t.id !== undefined) await pingApp(t.id);
        return null;
      }
      // Bring up the web app. If it is unlocked it connects this extension:
      // on its own when already linked to this account, else after Connect.
      await session.set({ wantsConnectUntil: Date.now() + CONNECT_TTL_MS });
      const [tab] = await appTabs();
      if (tab?.id !== undefined) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId !== undefined)
          await chrome.windows.update(tab.windowId, { focused: true });
        await pingApp(tab.id);
      } else await chrome.tabs.create({ url: __WEB_URL__ });
      return null;
    }
    case "bridgeHello": {
      const s = await session.get();
      const now = Date.now();
      const nonce = await issueNonce();
      const saved = await persisted.get();
      const { clientDeviceId, name } = await deviceInfo();
      return {
        nonce,
        status: await getStatus(),
        linkedUserId: saved?.userId ?? null,
        wantsConnect: (s.wantsConnectUntil ?? 0) > now,
        device: { clientDeviceId, name },
      } satisfies BridgeHello;
    }
    case "bridgeLink":
      return linkInTurn(() => bridgeLink(req));
    case "bridgeUnlockApp": {
      // The Minions app in this browser is locked and asks for the keys this
      // extension holds: the same account only, with a nonce from a hello.
      if (!(await takeNonce(req.nonce))) throw new Error("This request expired. Try again.");
      const s = await session.get();
      if (s.status !== "unlocked" || !s.vaultKey || !s.vaultId || s.userId !== req.userId)
        throw new Error("The extension is not unlocked for this account");
      await session.set({ lastActivity: Date.now() });
      return {
        userId: s.userId,
        vaultId: s.vaultId,
        vaultKey: s.vaultKey,
        privateKey: s.privateKey ?? null,
      };
    }
    case "bridgeLock":
      // Locked in the app: locked here too, or the app would reopen from here.
      if ((await session.get()).status === "unlocked") {
        await api("/vault/lock", { method: "POST" }).catch(() => undefined);
        await lockLocally();
        stateChanged();
      }
      return null;
    case "generate":
      return generatePassword(req.options);
    case "clipboardWritten":
      await scheduleClipboardClear();
      return null;
    case "capture": {
      const r = analyzeCapture(req.text);
      return {
        type: r.classification.type,
        label: getItemType(r.classification.type)?.label,
        provider: r.classification.provider,
        confidence: r.classification.confidence,
        name: r.suggestedName,
        secrets: r.secrets.length,
      };
    }
    case "saveCapture": {
      const r = analyzeCapture(req.text);
      const def = getItemType(r.classification.type);
      const secret = r.secrets[0];
      const key = await vaultKey();
      const id = crypto.randomUUID();
      const fieldFor: Record<string, string> = {
        LOGIN: "password",
        API_KEY: "api_key",
        SECRET: "secret",
        CLOUD: "secret_key",
        WEBHOOK: "secret",
        CREDIT_CARD: "number",
        SSH_KEY: "private_key",
        DATABASE: "connection_string",
        TOTP: "totp",
      };
      const fields: ItemField[] = [];
      const field = fieldFor[r.classification.type] ?? "notes";
      if (secret && def?.fields.some((f) => f.key === field))
        fields.push({
          key: field,
          value: await encryptString(key, secret.value, aad.field(id, field)),
          sensitive: true,
        });
      if (r.classification.provider && def?.fields.some((f) => f.key === "provider"))
        fields.push({ key: "provider", value: r.classification.provider, sensitive: false });
      if (r.email && def?.fields.some((f) => f.key === "email"))
        fields.push({ key: "email", value: r.email, sensitive: false });
      if (r.classification.environment && def?.fields.some((f) => f.key === "environment"))
        fields.push({ key: "environment", value: r.classification.environment, sensitive: false });
      await api("/vault/items", {
        body: {
          id,
          type: r.classification.type,
          name: req.name || r.suggestedName,
          fields,
          tags: r.classification.tags,
        },
      });
      return id;
    }
    case "formSubmitted": {
      const { status, recentUsername } = await session.get();
      const host = senderHost;
      if (status !== "unlocked" || !host || !req.password) return null;
      const prefs = await settings();
      if (prefs.offerSave === false) return null;
      if ((await neverSaveHosts()).includes(host)) return null;
      // A password page with no username on it: take the one from step one.
      const username =
        req.username ||
        (recentUsername?.host === host && Date.now() - recentUsername.at < USERNAME_TTL_MS
          ? recentUsername.username
          : "");
      const existing = await matchAll(host).catch(() => [] as ListedItem[]);
      const same = existing.find(
        (i) => (i.username ?? "").toLowerCase() === username.toLowerCase(),
      );
      if (same) {
        // Known login: only offer an update if the password actually changed,
        // and for a team login only to someone allowed to change it.
        if (same.workspaceId && same.permission !== "MANAGE") return null;
        if (same.shared && same.sharedPermission !== "EDIT") return null;
        const opened = await openItem(same.id, same.workspaceId, same.shared);
        const unchanged = (await decryptField(opened, "password")) === req.password;
        opened.key.fill(0);
        if (unchanged) return null;
      }
      const pending: SessionData["pending"] = {
        id: crypto.randomUUID(),
        host,
        url: new URL(sender.url!).origin,
        username,
        password: req.password,
        createdAt: Date.now(),
        // Saved without asking: a new login, or a password the user deliberately
        // changed (sign-up or change-password form). A different password typed
        // into a sign-in form may be a typo, so that one still asks.
        auto: prefs.autoSave !== false && (!same || !!req.fresh),
        ...(same
          ? {
              updateItemId: same.id,
              updateItemName: same.workspaceName
                ? `${same.name} (${same.workspaceName})`
                : same.sharedBy
                  ? `${same.name} (from ${same.sharedBy})`
                  : same.name,
              ...(same.workspaceId ? { updateWorkspaceId: same.workspaceId } : {}),
              ...(same.shared ? { updateShared: true } : {}),
            }
          : {}),
      };
      await session.set({ pending });
      await session.clear(["recentUsername"]);
      const tabId = sender.tab?.id;
      await chrome.action.setBadgeText({ text: "1", tabId });
      // The page may have moved on (a sign-in usually navigates) before this
      // was ready: tell whatever is in that tab now. It shows the prompt only
      // if it is still the same site.
      if (tabId !== undefined)
        chrome.tabs
          .sendMessage(tabId, { type: "minions-show-save" }, { frameId: 0 })
          .catch(() => undefined);
      return null;
    }
    case "pendingSave": {
      const pending = await currentPending();
      if (!pending || (fromContent && pending.host !== senderHost)) return null;
      const { password: _omit, createdAt: _at, ...publicPart } = pending;
      return publicPart satisfies PendingSave;
    }
    case "resolveSave": {
      const pending = await currentPending();
      if (!pending || pending.id !== req.id) return null;
      // A page can only answer for a login detected on its own site.
      if (fromContent && pending.host !== senderHost) return null;
      await session.clear(["pending"]);
      await chrome.action.setBadgeText({ text: "" });
      if (req.action === "never") {
        await addNeverSave(pending.host);
        return null;
      }
      if (req.action === "ignore") return null;
      if (req.action === "update" && pending.updateItemId) {
        const opened = await openItem(
          pending.updateItemId,
          pending.updateWorkspaceId,
          pending.updateShared,
        );
        const { item, key } = opened;
        const previous = storedFields(item);
        const pw = {
          key: "password",
          value: await encryptString(key, pending.password, aad.field(item.id, "password")),
          sensitive: true,
        };
        const next = previous.some((f) => f.key === "password")
          ? previous.map((f) => (f.key === "password" ? pw : f))
          : [...previous, pw];
        await writeItem(opened, next, pending.password);
        key.fill(0);
        await session.set({
          lastSaved: {
            id: pending.id,
            host: pending.host,
            action: "updated",
            itemId: item.id,
            ...(pending.updateWorkspaceId ? { workspaceId: pending.updateWorkspaceId } : {}),
            ...(pending.updateShared ? { shared: true } : {}),
            previous,
            at: Date.now(),
          },
        });
        return "updated";
      }
      const login = await buildLogin(pending.host, pending.url, pending.username, pending.password);
      await api("/vault/items", { body: login });
      await session.set({
        lastSaved: {
          id: pending.id,
          host: pending.host,
          action: "saved",
          itemId: login.id!,
          at: Date.now(),
        },
      });
      return "saved";
    }
    case "undoSave": {
      const { lastSaved } = await session.get();
      if (!lastSaved || lastSaved.id !== req.id || Date.now() - lastSaved.at > UNDO_TTL_MS)
        throw new Error("This can no longer be undone");
      if (fromContent && lastSaved.host !== senderHost) throw new Error("Not allowed");
      await session.clear(["lastSaved"]);
      if (lastSaved.action === "saved") {
        // Into the trash, where it can still be restored in the app.
        await api(`/vault/items/${lastSaved.itemId}`, { method: "DELETE" });
        return "removed";
      }
      const opened = await openItem(lastSaved.itemId, lastSaved.workspaceId, lastSaved.shared);
      const previous = lastSaved.previous ?? [];
      const old = previous.find((f) => f.key === "password");
      const oldPassword = old
        ? await decryptString(opened.key, old.value, aad.field(opened.item.id, "password"))
        : "";
      await writeItem(opened, previous, oldPassword);
      opened.key.fill(0);
      return "restored";
    }
  }
}

/** The app hands this extension a session of its own and the vault keys. */
async function bridgeLink(req: Extract<Request, { type: "bridgeLink" }>) {
  const s = await session.get();
  const now = Date.now();
  if (!(await takeNonce(req.nonce))) {
    await discardOffered(req.token);
    throw new Error("This connection request expired. Try again.");
  }
  const saved = await persisted.get();
  if ((await getStatus()) === "unlocked" && saved?.userId === req.userId) {
    // Another app tab got there first: this extra session is not needed.
    await discardOffered(req.token);
    return "already";
  }
  // The session must be real, unlocked, and the account the keys claim to be for.
  const me = await api<MeResponse>("/auth/me", { token: req.token }).catch(() => null);
  const vk = fromBase64(req.vaultKey);
  if (
    !me ||
    me.user.id !== req.userId ||
    me.vaultId !== req.vaultId ||
    !me.session.vaultUnlocked ||
    vk.length !== 32
  ) {
    vk.fill(0);
    await discardOffered(req.token);
    throw new Error("The connection could not be verified");
  }
  vk.fill(0);
  // Replaces whatever was here: this account's old session, or another account.
  const old = s.token ?? saved?.token;
  if (old && old !== req.token) await revokeToken(old);
  await chrome.storage.session.clear();
  await chrome.action.setBadgeText({ text: "" });
  await session.set({
    token: req.token,
    email: me.user.email,
    name: me.user.name,
    userId: me.user.id,
    vaultId: me.vaultId,
    vaultKey: req.vaultKey,
    ...(req.privateKey ? { privateKey: req.privateKey } : {}),
    status: "unlocked",
    autoLockMinutes: me.user.autoLockMinutes,
    lastActivity: now,
  });
  await persistSignIn();
  await scheduleLock();
  await rememberIfWanted();
  stateChanged();
  return "linked";
}

chrome.runtime.onMessage.addListener(
  (req: Request, sender, sendResponse: (r: Response) => void) => {
    // Addressed to the offscreen document, not to the background.
    if ((req as { target?: string }).target === "offscreen") return false;
    handle(req, sender).then(
      (data) => sendResponse({ ok: true, data }),
      (e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : "Something went wrong" }),
    );
    return true;
  },
);
