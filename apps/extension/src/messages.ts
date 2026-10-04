import type { PasswordOptions, VaultItemSummary } from "@minions/core";

export type Status = "signed-out" | "two-factor" | "locked" | "unlocked";

export interface StateResponse {
  status: Status;
  email: string | null;
  apiUrl: string;
  webUrl: string;
}

/** A personal item, or a workspace item (then `workspaceId` says where its key comes from). */
export type ListedItem = VaultItemSummary & {
  workspaceId?: string;
  workspaceName?: string;
  permission?: "VIEW" | "MANAGE";
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
  | { type: "fill"; tabId: number; itemId: string; workspaceId?: string }
  | { type: "copy"; itemId: string; field: string; workspaceId?: string }
  | { type: "totp"; itemId: string; workspaceId?: string }
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
  | { type: "activity" };

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
      return true;
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
        optionalId(m.workspaceId)
      );
    case "copy":
      return (
        str(m.itemId, 36) &&
        UUID.test(m.itemId as string) &&
        str(m.field, 120) &&
        optionalId(m.workspaceId)
      );
    case "totp":
      return str(m.itemId, 36) && UUID.test(m.itemId as string) && optionalId(m.workspaceId);
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
