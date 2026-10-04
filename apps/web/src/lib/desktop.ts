import { invoke } from "@tauri-apps/api/core";
import { isTauri, setBearerToken } from "./api";

/**
 * Desktop only: the session token is kept in the OS credential store so the
 * app does not ask you to sign in on every launch. The vault key is never
 * stored; a restarted app is locked until the master password is entered.
 */
export async function restoreDesktopSession(): Promise<void> {
  if (!isTauri) return;
  const token = await invoke<string | null>("session_token_get").catch(() => null);
  if (token) setBearerToken(token);
}

export function rememberDesktopSession(token: string | undefined) {
  if (!isTauri || !token) return;
  void invoke("session_token_set", { token }).catch(() => undefined);
}

export function forgetDesktopSession() {
  if (!isTauri) return;
  void invoke("session_token_clear").catch(() => undefined);
}
