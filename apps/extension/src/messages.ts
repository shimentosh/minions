import type { PasswordOptions, VaultItemSummary } from "@minions/core";

export type Status = "signed-out" | "two-factor" | "locked" | "unlocked";

export interface StateResponse {
  status: Status;
  email: string | null;
  name: string | null;
  /** Signed in through the Minions app: it unlocks again whenever the app does. */
  linked: boolean;
  apiUrl: string;
  webUrl: string;
}

/** One field of an item, as the detail view shows it. Secrets come only on reveal or copy. */
export interface ItemFieldView {
  key: string;
  label: string;
  sensitive: boolean;
  kind: string;
  /** Non-sensitive fields only; null for secrets. */
  value: string | null;
}

export interface ItemView {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  host: string | null;
  url: string | null;
  favorite: boolean;
  hasTotp: boolean;
  workspaceId?: string;
  workspaceName?: string;
  shared?: boolean;
  sharedBy?: string;
  /** The page in the given tab is this item's site. */
  canFill: boolean;
  fields: ItemFieldView[];
}

/** A live 2FA code. The secret stays in the background; only codes reach the popup. */
export interface TotpEntry {
  id: string;
  name: string;
  subtitle: string | null;
  favorite: boolean;
  /** Null when the secret could not be read. */
  code: string | null;
  next: string | null;
  remaining: number;
  period: number;
}

/** Extension → Minions web app (through the content script on the app's origin). */
export interface BridgeHello {
  nonce: string;
  status: Status;
  linkedUserId: string | null;
  wantsConnect: boolean;
  device: { clientDeviceId: string; name: string };
}

/** Minions web app → extension: a session of the extension's own and the vault keys. */
export interface BridgeLink {
  nonce: string;
  token: string;
  userId: string;
  vaultId: string;
  email: string;
  autoLockMinutes: number;
  vaultKey: string;
  privateKey: string | null;
}

/**
 * A personal item, a workspace item (then `workspaceId` says where its key
 * comes from), or an item someone shared with the user (`shared`).
 */
export type ListedItem = VaultItemSummary & {
  workspaceId?: string;
  workspaceName?: string;
  permission?: "VIEW" | "MANAGE";
  shared?: boolean;
  /** Who shared it, for the label. */
  sharedBy?: string;
  sharedPermission?: "VIEW" | "EDIT";
};

export interface MatchResponse {
  host: string | null;
  items: ListedItem[];
}

export interface PendingSave {
  id: string;
  host: string;
  url: string;
  username: string;
  /** Existing item with the same username: offer "update password" instead of "save". */
  updateItemId?: string;
  updateItemName?: string;
  /** The item to update is a workspace credential the user can manage. */
  updateWorkspaceId?: string;
  /** The item to update was shared with the user, with edit access. */
  updateShared?: boolean;
  /** Save without asking once the sign-in has gone through (the page shows an Undo). */
  auto?: boolean;
}

export type SaveAction = "save" | "update" | "ignore" | "never";

/** A login offered in the menu under a page's login field. Names only: never a secret. */
export interface InlineItem {
  id: string;
  name: string;
  username: string | null;
  /** Where a team or shared login comes from. */
  badge: string | null;
  hasTotp: boolean;
  /** Saved without a website: offered by name, filled only after the user confirms. */
  unlinked?: boolean;
  workspaceId?: string;
  shared?: boolean;
}

/** What the page's login-field menu may show: the logins for the page's own site, if unlocked. */
export interface InlineMatch {
  status: Status;
  /** The user turned the menu off in settings. */
  enabled: boolean;
  /** The page's site, as the browser reports it. */
  host: string | null;
  items: InlineItem[];
  /** When nothing matches: logins saved without a website whose name fits this site. */
  suggested: InlineItem[];
  /** For sign-up forms: the user's chosen sign-up email, then their account email. */
  emails: string[];
}

/** A 2FA code for the page's menu: the code and how long it has left. */
export interface TotpCode {
  code: string;
  remaining: number;
  period: number;
}

/** Preferences kept in chrome.storage.local (never a secret). */
export interface Settings {
  /** The email offered on sign-up forms; the account email when unset. */
  signupEmail?: string;
  /** The menu under login, sign-up and 2FA fields. */
  inlineMenu?: boolean;
  /** Ask to save logins the user signs in with. */
  offerSave?: boolean;
  /** Save new logins (and deliberate password changes) without asking, with an Undo. */
  autoSave?: boolean;
  /**
   * Keep the vault keys on this computer, encrypted in the extension, so it
   * opens again after the browser restarts. Off by default; lock or sign out
   * deletes them.
   */
  rememberDevice?: boolean;
  /**
   * "browser" (default): once unlocked, stay unlocked until the browser closes.
   * "idle": lock after the account's auto-lock time away from the computer.
   */
  lockMode?: "browser" | "idle";
}

/** Popup/content → background. The vault key and secrets never travel the other way unasked. */
export type Request =
  | { type: "state" }
  | { type: "login"; email: string; password: string }
  | { type: "verify2fa"; code: string }
  | { type: "unlock"; password: string }
  | { type: "lock" }
  | { type: "logout" }
  | { type: "match"; tabId: number }
  | { type: "search"; q: string }
  | { type: "fill"; tabId: number; itemId: string; workspaceId?: string; shared?: boolean }
  | { type: "copy"; itemId: string; field: string; workspaceId?: string; shared?: boolean }
  /** `quiet`: a code shown on screen, not used; only copies are recorded. */
  | { type: "totp"; itemId: string; workspaceId?: string; shared?: boolean; quiet?: boolean }
  | { type: "totpList" }
  | { type: "item"; itemId: string; workspaceId?: string; shared?: boolean; tabId?: number }
  | { type: "reveal"; itemId: string; field: string; workspaceId?: string; shared?: boolean }
  /**
   * "Sign in with Minions app": find or open the app so it can connect this
   * extension. `silent`: only nudge app tabs already open, in the background.
   */
  | { type: "connect"; silent?: boolean }
  | { type: "browse"; view: "favorites" | "recent" }
  | { type: "generate"; options: PasswordOptions }
  | { type: "capture"; text: string }
  | { type: "saveCapture"; text: string; name: string }
  /** The popup put a secret on the clipboard: the background clears it later. */
  | { type: "clipboardWritten" }
  // From the content script, with the user's own submission on that page. The
  // page's address is taken from the browser (sender.url), never from here.
  | {
      type: "formSubmitted";
      username: string;
      password: string;
      /** From a sign-up or change-password field: a password the user meant to set. */
      fresh?: boolean;
    }
  | { type: "pendingSave" }
  | { type: "resolveSave"; id: string; action: SaveAction }
  /** The logins for the sender page's site (taken from the browser, not the page). */
  | { type: "inlineMatch" }
  /** The user picked a login in the page's menu: fill it into that same tab. */
  | {
      type: "inlineFill";
      itemId: string;
      workspaceId?: string;
      shared?: boolean;
      /** A login saved without a website, confirmed for this page: fill it and remember the site. */
      link?: boolean;
    }
  /** The user removed a login for this page's site from the page's menu: to the Trash, not erased. */
  | { type: "inlineTrash"; itemId: string }
  /** Undo for inlineTrash: back from the Trash. */
  | { type: "inlineRestore"; itemId: string }
  /** Step one of a two-step sign-in: the username, remembered briefly for the password step. */
  | { type: "usernameSeen"; username: string }
  /** A strong password for a sign-up or change-password field, from the user's generator settings. */
  | { type: "inlineGenerate" }
  /** The current 2FA code of a login for the sender page's site. */
  | {
      type: "inlineTotp";
      itemId: string;
      workspaceId?: string;
      shared?: boolean;
      /** Shown in the menu, not used: not recorded. */
      peek?: boolean;
    }
  /** Undo the save or update the page's toast just announced. */
  | { type: "undoSave"; id: string }
  /** The page's menu asks the user to unlock: open the toolbar popup. */
  | { type: "openPopup" }
  | { type: "activity" }
  /** The "Remember on this computer" switch changed: keep or drop the keys now. */
  | { type: "rememberDevice"; on: boolean }
  // From the content script on the Minions web app's own origin only.
  | { type: "bridgeHello" }
  /** The app is locked: the keys this extension holds, for the same account. */
  | { type: "bridgeUnlockApp"; nonce: string; userId: string }
  /** The app was locked by the user: lock here too. */
  | { type: "bridgeLock" }
  | ({ type: "bridgeLink" } & BridgeLink);

/** Background → content script: fill the one login the user picked. */
export interface FillMessage {
  type: "minions-fill";
  /** The content script refuses unless its page is still on this origin. */
  origin: string;
  username: string;
  password: string;
}

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const SAVE_ACTIONS: readonly SaveAction[] = ["save", "update", "ignore", "never"];
const optionalId = (v: unknown) => v === undefined || (str(v, 36) && UUID.test(v as string));
const optionalBool = (v: unknown) => v === undefined || typeof v === "boolean";
const uuid = (v: unknown) => str(v, 36) && UUID.test(v as string);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const base64 = (v: unknown, max: number) => str(v, max) && BASE64.test(v as string);

/**
 * Shape check for every incoming message. A content script runs on pages the
 * user did not write, so nothing is trusted because of its `type` alone.
 */
export function isValidRequest(msg: unknown): msg is Request {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "state":
    case "lock":
    case "logout":
    case "pendingSave":
    case "activity":
    case "clipboardWritten":
    case "totpList":
    case "bridgeHello":
    case "bridgeLock":
    case "inlineMatch":
    case "inlineGenerate":
    case "openPopup":
      return true;
    case "inlineFill":
      return (
        uuid(m.itemId) &&
        optionalId(m.workspaceId) &&
        optionalBool(m.shared) &&
        optionalBool(m.link)
      );
    case "inlineTrash":
    case "inlineRestore":
      return uuid(m.itemId);
    case "inlineTotp":
      return (
        uuid(m.itemId) &&
        optionalId(m.workspaceId) &&
        optionalBool(m.shared) &&
        optionalBool(m.peek)
      );
    case "undoSave":
      return uuid(m.id);
    case "usernameSeen":
      return str(m.username, 256);
    case "connect":
      return optionalBool(m.silent);
    case "rememberDevice":
      return typeof m.on === "boolean";
    case "browse":
      return m.view === "favorites" || m.view === "recent";
    case "login":
      return str(m.email, 254) && str(m.password, 1024);
    case "verify2fa":
      return str(m.code, 20);
    case "unlock":
      return str(m.password, 1024);
    case "match":
      return Number.isInteger(m.tabId);
    case "search":
      return str(m.q, 200);
    case "fill":
      return (
        Number.isInteger(m.tabId) &&
        str(m.itemId, 36) &&
        UUID.test(m.itemId as string) &&
        optionalId(m.workspaceId) &&
        optionalBool(m.shared)
      );
    case "copy":
      return (
        str(m.itemId, 36) &&
        UUID.test(m.itemId as string) &&
        str(m.field, 120) &&
        optionalId(m.workspaceId) &&
        optionalBool(m.shared)
      );
    case "totp":
      return (
        uuid(m.itemId) &&
        optionalId(m.workspaceId) &&
        optionalBool(m.shared) &&
        optionalBool(m.quiet)
      );
    case "item":
      return (
        uuid(m.itemId) &&
        optionalId(m.workspaceId) &&
        optionalBool(m.shared) &&
        (m.tabId === undefined || Number.isInteger(m.tabId))
      );
    case "reveal":
      return (
        uuid(m.itemId) && str(m.field, 120) && optionalId(m.workspaceId) && optionalBool(m.shared)
      );
    case "bridgeUnlockApp":
      return uuid(m.nonce) && uuid(m.userId);
    case "bridgeLink":
      return (
        uuid(m.nonce) &&
        str(m.token, 200) &&
        (m.token as string).length >= 16 &&
        uuid(m.userId) &&
        uuid(m.vaultId) &&
        str(m.email, 254) &&
        Number.isInteger(m.autoLockMinutes) &&
        (m.autoLockMinutes as number) >= 0 &&
        (m.autoLockMinutes as number) <= 43_200 &&
        base64(m.vaultKey, 64) &&
        (m.privateKey === null || base64(m.privateKey, 8192))
      );
    case "generate":
      return !!m.options && typeof m.options === "object";
    case "capture":
      return str(m.text, 20_000);
    case "saveCapture":
      return str(m.text, 20_000) && str(m.name, 200);
    case "formSubmitted":
      return str(m.username, 256) && str(m.password, 1024) && optionalBool(m.fresh);
    case "resolveSave":
      return (
        str(m.id, 36) && UUID.test(m.id as string) && SAVE_ACTIONS.includes(m.action as SaveAction)
      );
    default:
      return false;
  }
}

export async function send<T>(req: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<T> | undefined;
  if (!res) throw new Error("No response from Minions");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
