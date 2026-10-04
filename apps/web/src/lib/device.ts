import type { DeviceInfo } from "@minions/core";
import { clientKind } from "./api";

const KEY = "minions-device-id";

/**
 * A random id for this browser, so the account can list and revoke it. It is
 * not a secret and grants nothing on its own.
 */
export function deviceInfo(): DeviceInfo {
  let id: string | null = null;
  try {
    id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
  } catch {
    id = crypto.randomUUID();
  }
  return { clientDeviceId: id, name: deviceName(), kind: clientKind };
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "Unknown OS";
  if (clientKind === "desktop") return `Minions desktop on ${os}`;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} on ${os}`;
}
