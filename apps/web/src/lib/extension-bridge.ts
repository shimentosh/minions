import { useEffect } from "react";
import { create } from "zustand";
import { errorMessage, isTauri, post } from "./api";
import { keysForExtension, useSession } from "./session";
import { toast } from "./toast";

/**
 * "Sign in with the Minions app" for the browser extension.
 *
 * The extension's content script runs on this page (and only answers on this
 * app's own origin, which the extension checks against the address the
 * browser reports, not one the page claims). The two talk over
 * window.postMessage on this origin:
 *
 *   extension → app  hello   its status, whether it is linked to an account,
 *                            and a one-time nonce for the next link
 *   app → extension  link    a fresh session of its own plus the vault key
 *
 * The first link needs the user to press Connect here. After that, an
 * extension linked to this account unlocks on its own whenever this app is
 * unlocked in the same browser, so the master password is typed once.
 */

export type ExtensionStatus = "signed-out" | "two-factor" | "locked" | "unlocked";

export interface ExtensionHello {
  nonce: string;
  status: ExtensionStatus;
  linkedUserId: string | null;
  /** The user pressed "Sign in with Minions app" in the extension. */
  wantsConnect: boolean;
  device: { clientDeviceId: string; name: string };
}

interface BridgeState {
  extension: ExtensionHello | null;
  linking: boolean;
  /** The user closed the connect prompt for this nonce. */
  dismissedNonce: string | null;
}

export const useExtensionBridge = create<BridgeState>(() => ({
  extension: null,
  linking: false,
  dismissedNonce: null,
}));

const FROM_EXTENSION = "minions-extension";
const FROM_APP = "minions-app";
const STATUSES: readonly ExtensionStatus[] = ["signed-out", "two-factor", "locked", "unlocked"];

function isHello(d: Record<string, unknown>): ExtensionHello | null {
  const device = d.device as Record<string, unknown> | undefined;
  if (
    typeof d.nonce !== "string" ||
    !/^[0-9a-f-]{36}$/.test(d.nonce) ||
    !STATUSES.includes(d.status as ExtensionStatus) ||
    !(d.linkedUserId === null || typeof d.linkedUserId === "string") ||
    typeof d.wantsConnect !== "boolean" ||
    !device ||
    typeof device.clientDeviceId !== "string" ||
    typeof device.name !== "string"
  )
    return null;
  return {
    nonce: d.nonce,
    status: d.status as ExtensionStatus,
    linkedUserId: d.linkedUserId as string | null,
    wantsConnect: d.wantsConnect,
    device: { clientDeviceId: device.clientDeviceId, name: device.name.slice(0, 100) },
  };
}

let linkedWaiter: ((r: { ok: boolean; error?: string }) => void) | null = null;

function onMessage(e: MessageEvent) {
  // Only this window, on this origin: the extension's content script posts here.
  if (e.source !== window || e.origin !== window.location.origin) return;
  const d = e.data as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || d.source !== FROM_EXTENSION) return;
  if (d.type === "hello") {
    const hello = isHello(d);
    if (hello) useExtensionBridge.setState({ extension: hello });
  } else if (d.type === "linked") {
    linkedWaiter?.({ ok: d.ok === true, error: typeof d.error === "string" ? d.error : undefined });
    linkedWaiter = null;
  }
}

function ping() {
  window.postMessage({ source: FROM_APP, type: "ping" }, window.location.origin);
}

// Desktop (Tauri) has no browser extension.
if (typeof window !== "undefined" && !isTauri) {
  window.addEventListener("message", onMessage);
  ping();
}

function waitForLinked(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      linkedWaiter = null;
      resolve({ ok: false, error: "The extension did not answer" });
    }, 10_000);
    linkedWaiter = (r) => {
      window.clearTimeout(timer);
      resolve(r);
    };
  });
}

/** Opens a session for the extension and hands it the keys. */
export async function connectExtension(opts: { quiet?: boolean } = {}): Promise<boolean> {
  const { extension, linking } = useExtensionBridge.getState();
  const me = useSession.getState().me;
  if (!extension || !me || linking) return false;
  useExtensionBridge.setState({ linking: true });
  try {
    const { token } = await post<{ token: string }>("/vault/extension-link", {
      device: { ...extension.device, kind: "extension" },
    });
    const keys = await keysForExtension();
    const answer = waitForLinked();
    window.postMessage(
      {
        source: FROM_APP,
        type: "link",
        nonce: extension.nonce,
        token,
        userId: me.user.id,
        vaultId: me.vaultId,
        email: me.user.email,
        autoLockMinutes: me.user.autoLockMinutes,
        ...keys,
      },
      window.location.origin,
    );
    const result = await answer;
    if (!result.ok) throw new Error(result.error ?? "The extension refused the connection");
    if (!opts.quiet) toast.success("Extension connected", "It unlocks with this app from now on.");
    return true;
  } catch (e) {
    if (!opts.quiet) toast.error(errorMessage(e));
    return false;
  } finally {
    useExtensionBridge.setState({ linking: false });
    ping();
  }
}

/** At most one silent unlock a minute, so a refusing extension cannot cause a loop of sessions. */
const AUTO_INTERVAL_MS = 60_000;
let lastAutoConnect = 0;

/**
 * Mounted in the unlocked app. Unlocks an extension already linked to this
 * account without asking; a first connection waits for the user's Connect.
 */
export function useExtensionAutoConnect() {
  const extension = useExtensionBridge((s) => s.extension);
  const linking = useExtensionBridge((s) => s.linking);
  const status = useSession((s) => s.status);
  const userId = useSession((s) => s.me?.user.id);

  useEffect(() => {
    if (status !== "unlocked") return;
    ping();
    const again = () => document.visibilityState === "visible" && ping();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [status]);

  useEffect(() => {
    if (status !== "unlocked" || linking || !extension || !userId) return;
    if (extension.status === "unlocked" && extension.linkedUserId === userId) return;
    if (extension.linkedUserId !== userId || Date.now() - lastAutoConnect < AUTO_INTERVAL_MS)
      return;
    lastAutoConnect = Date.now();
    void connectExtension({ quiet: true });
  }, [status, linking, extension, userId]);
}
