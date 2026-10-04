import { post } from "./api";
import { itemPath } from "./item-keys";
import { useSession } from "./session";
import { toast } from "./toast";

let clearTimer: number | undefined;
let lastCopied: string | null = null;

/**
 * Copies a value and clears the clipboard after the user's chosen delay,
 * unless they have copied something else meanwhile. The value is never
 * logged; only "copied field X of item Y" is recorded.
 */
export async function copySecret(
  value: string,
  opts: { label: string; itemId?: string; field?: string; sensitive?: boolean } = {
    label: "Value",
  },
) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    toast.error("Couldn't copy to the clipboard");
    return;
  }
  const seconds = useSession.getState().me?.user.clipboardClearSeconds ?? 30;
  const sensitive = opts.sensitive ?? true;
  if (sensitive) {
    lastCopied = value;
    window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(async () => {
      try {
        // Reading needs permission in some browsers; if we cannot check, clear anyway.
        const current = await navigator.clipboard.readText().catch(() => lastCopied);
        if (current === lastCopied) await navigator.clipboard.writeText("");
      } catch {
        /* The tab may be in the background; nothing else to do. */
      }
      lastCopied = null;
    }, seconds * 1000);
    toast.success(`${opts.label} copied`, `Clipboard clears in ${seconds} seconds.`);
  } else {
    toast.success(`${opts.label} copied`);
  }
  if (opts.itemId) {
    void post(`${itemPath(opts.itemId)}/usage`, {
      action: opts.field === "totp" ? "item.totp_generated" : "item.copied",
      field: opts.field,
    }).catch(() => undefined);
  }
}
