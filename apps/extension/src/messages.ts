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
}

export type SaveAction = "save" | "update" | "ignore" | "never";

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
  | { type: "formSubmitted"; username: string; password: string }
  | { type: "pendingSave" }
  | { type: "resolveSave"; id: string; action: SaveAction }
  | { type: "activity" }
  // From the content script on the Minions web app's own origin only.
  | { type: "bridgeHello" }
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
      return true;
    case "connect":
      return optionalBool(m.silent);
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
        (m.autoLockMinutes as number) <= 1440 &&
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
      return str(m.username, 256) && str(m.password, 1024);
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
