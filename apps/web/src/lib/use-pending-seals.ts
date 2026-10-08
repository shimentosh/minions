import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { completePendingSeals } from "./people-sharing";
import { useSession } from "./session";
import { toast } from "./toast";

const EVERY_MS = 2 * 60_000;

/**
 * While the vault is open: hands over items shared with people who have
 * since become able to receive them. Only this client can, since only it
 * can open the item keys.
 */
export function usePendingSeals() {
  const status = useSession((s) => s.status);
  const verified = useSession((s) => s.me?.user.emailVerified);
  const qc = useQueryClient();
  useEffect(() => {
    if (status !== "unlocked" || !verified) return;
    const run = async () => {
      const done = await completePendingSeals().catch(() => []);
      if (!done.length) return;
      void qc.invalidateQueries({ queryKey: ["people"] });
      toast.success(
        done.length === 1
          ? `${done[0]!.recipient.name} can now open ${done[0]!.itemName}`
          : `${done.length} shared items handed over`,
        "They joined Minions, so your app passed them the key.",
      );
    };
    void run();
    const timer = window.setInterval(() => void run(), EVERY_MS);
    const onFocus = () => void run();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [status, verified, qc]);
}
