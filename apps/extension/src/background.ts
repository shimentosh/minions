/**
 * The extension's only privileged context.
 *
 * - Session token and vault key live in chrome.storage.session, which is held
 *   in memory, never written to disk, cleared when the browser closes, and
 *   (with TRUSTED_CONTEXTS) unreadable from content scripts.
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
  decryptString,
  deriveMasterKeys,
  encryptString,
  estimateStrength,
  fromBase64,
  generatePassword,
  generateTotp,
  getItemType,
  type ItemField,
  importPrivateKey,
  keyAad,
  type MeResponse,
  normalizeHost,
  openSealedKey,
  type Page,
  type SharedItemDetail,
  type SharedWithMeItem,
  sealContext,
  secretFingerprint,
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
  type FillMessage,
  isValidRequest,
  type ListedItem,
  type MatchResponse,
  type PendingSave,
  type Request,
  type Response,
  type StateResponse,
  type Status,
} from "./messages";

declare const __API_URL__: string;
declare const __WEB_URL__: string;

const LOCK_ALARM = "minions-autolock";
const CLIPBOARD_ALARM = "minions-clipboard";
/** A detected login waits this long for the user's answer, then is dropped. */
const PENDING_TTL_MS = 5 * 60_000;
const NEVER_SAVE_LIMIT = 500;

interface SessionData {
  token?: string;
  email?: string;
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
  pending?: PendingSave & { password: string; createdAt: number };
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

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const { token } = await session.get();
  const url = new URL(path, __API_URL__);
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
  if (res.status === 401) {
    await signOutLocally();
    throw new Error("Signed out. Sign in again.");
  }
  if (data?.code === "VAULT_LOCKED") {
    await lockLocally();
    throw new Error("Vault locked");
  }
  if (!res.ok)
    throw new Error(
      Array.isArray(data?.message)
        ? data.message[0]
        : (data?.message ?? `Request failed (${res.status})`),
    );
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
    ...(pk ? { privateKey: toBase64(pk), userId: keys.userId } : {}),
    vaultKey: toBase64(vk),
    vaultId: keys.vaultId,
    status: "unlocked",
    autoLockMinutes: me.user.autoLockMinutes,
    email: me.user.email,
    lastActivity: Date.now(),
  });
  vk.fill(0);
  pk?.fill(0);
  await scheduleLock();
}

async function lockLocally() {
  await session.clear(["vaultKey", "privateKey", "stretchedKey", "pending"]);
  const { token } = await session.get();
  await session.set({ status: token ? "locked" : "signed-out" });
  await chrome.alarms.clear(LOCK_ALARM);
  await chrome.action.setBadgeText({ text: "" });
}

async function signOutLocally() {
  await chrome.storage.session.clear();
  await session.set({ status: "signed-out" });
  await chrome.alarms.clear(LOCK_ALARM);
}

async function scheduleLock() {
  const { autoLockMinutes = 15 } = await session.get();
  await chrome.alarms.create(LOCK_ALARM, { periodInMinutes: 1 });
  if (autoLockMinutes === 0) await chrome.alarms.create(LOCK_ALARM, { delayInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CLIPBOARD_ALARM) {
    await clearClipboard().catch(() => undefined);
    return;
  }
  if (alarm.name !== LOCK_ALARM) return;
  const { lastActivity = 0, autoLockMinutes = 15, status } = await session.get();
  if (status === "unlocked" && Date.now() - lastActivity > Math.max(autoLockMinutes, 1) * 60_000) {
    await api("/vault/lock", { method: "POST" }).catch(() => undefined);
    await lockLocally();
  }
});

async function getStatus(): Promise<Status> {
  const s = await session.get();
  if (!s.token) return s.status === "two-factor" ? "two-factor" : "signed-out";
  return s.status ?? "locked";
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
async function matchAll(host: string): Promise<ListedItem[]> {
  const [mine, team, shared] = await Promise.all([
    api<VaultItemSummary[]>("/vault/items/match", { query: { host } }),
    api<ListedItem[]>("/workspaces/items/match", { query: { host } }).catch(() => []),
    api<SharedWithMeItem[]>("/shared/match", { query: { host } }).catch(() => []),
  ]);
  return [...mine, ...team, ...listShared(shared)];
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
    if (!["formSubmitted", "pendingSave", "resolveSave"].includes(req.type))
      throw new Error("Not allowed");
    if (sender.frameId !== 0 || !sender.tab) throw new Error("Not allowed");
  } else await session.set({ lastActivity: Date.now() });
  // For content scripts: the page's host as the browser reports it, never as the page claims.
  const senderHost = fromContent ? normalizeHost(sender.url ?? null) : null;

  switch (req.type) {
    case "state": {
      const s = await session.get();
      return {
        status: await getStatus(),
        email: s.email ?? null,
        apiUrl: __API_URL__,
        webUrl: __WEB_URL__,
      } satisfies StateResponse;
    }
    case "activity":
      return null;
    case "login": {
      const { kdf } = await api<{ kdf: VaultKeys["kdf"] }>("/auth/prelogin", {
        body: { email: req.email },
      });
      const { authKey, stretchedKey } = await deriveMasterKeys(req.password, kdf);
      const result = await api<AuthResult>("/auth/login", {
        body: { email: req.email, authKey, device: await deviceInfo() },
      });
      await session.set({ token: result.token, email: req.email });
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
    case "search": {
      await vaultKey();
      const [page, team, shared] = await Promise.all([
        api<Page<VaultItemSummary>>("/vault/items", { query: { q: req.q, limit: "10" } }),
        api<ListedItem[]>("/workspaces/items/search", { query: { q: req.q } }).catch(() => []),
        api<SharedWithMeItem[]>("/shared/search", { query: { q: req.q } }).catch(() => []),
      ]);
      return [...page.items, ...team, ...listShared(shared)] satisfies ListedItem[];
    }
    case "fill": {
      const tab = await chrome.tabs.get(req.tabId);
      const pageUrl = tab.url ?? "";
      const host = normalizeHost(pageUrl);
      const opened = await openItem(req.itemId, req.workspaceId, req.shared);
      const { item } = opened;
      const savedUrl = item.fields.find((f) => f.key === "url" && !f.sensitive)?.value ?? null;
      // Only fill a page whose site matches the item (public-suffix aware,
      // compared in punycode), and never an https login into an http page.
      // A look-alike or phishing domain gets nothing.
      if (!canFill(savedUrl, item.host, pageUrl)) {
        throw new Error(
          `This login is for ${item.host ?? "another site"}, not ${host ?? "this page"}`,
        );
      }
      const username =
        (await decryptField(opened, "username")) ?? (await decryptField(opened, "email")) ?? "";
      const password = (await decryptField(opened, "password")) ?? "";
      opened.key.fill(0);
      const msg: FillMessage = {
        type: "minions-fill",
        origin: new URL(pageUrl).origin,
        username,
        password,
      };
      // Top frame only: an embedded, possibly cross-origin iframe never receives credentials.
      const res = (await chrome.tabs.sendMessage(req.tabId, msg, { frameId: 0 })) as
        | { filled?: boolean }
        | undefined;
      if (!res?.filled) throw new Error("No login form found on this page");
      await recordUsage(opened, "item.autofilled");
      return null;
    }
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
      await recordUsage(opened, "item.totp_generated");
      return generateTotp(secret);
    }
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
      const { status } = await session.get();
      const host = senderHost;
      if (status !== "unlocked" || !host || !req.password) return null;
      if ((await neverSaveHosts()).includes(host)) return null;
      const existing = await matchAll(host).catch(() => [] as ListedItem[]);
      const same = existing.find(
        (i) => (i.username ?? "").toLowerCase() === req.username.toLowerCase(),
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
        username: req.username,
        password: req.password,
        createdAt: Date.now(),
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
      await chrome.action.setBadgeText({ text: "1", tabId: sender.tab?.id });
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
        // Workspace and shared items: no personal projects, no reuse fingerprint.
        const team = !!pending.updateWorkspaceId || !!pending.updateShared;
        const fields = item.fields.map((f) => ({
          key: f.key,
          value: f.value,
          sensitive: f.sensitive,
          ...(f.label ? { label: f.label, kind: f.kind } : {}),
        }));
        const pw = {
          key: "password",
          value: await encryptString(key, pending.password, aad.field(item.id, "password")),
          sensitive: true,
        };
        const next = fields.some((f) => f.key === "password")
          ? fields.map((f) => (f.key === "password" ? pw : f))
          : [...fields, pw];
        await api(itemPath(item.id, pending.updateWorkspaceId, pending.updateShared), {
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
            fields: next,
            revision: item.revision,
            signals: {
              passwordStrength: estimateStrength(pending.password).score,
              // Reuse detection compares personal passwords only.
              ...(team
                ? {}
                : {
                    passwordFingerprint: await secretFingerprint(
                      await vaultKey(),
                      pending.password,
                    ),
                  }),
            },
          },
        });
        key.fill(0);
        return "updated";
      }
      await api("/vault/items", {
        body: await buildLogin(pending.host, pending.url, pending.username, pending.password),
      });
      return "saved";
    }
  }
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
