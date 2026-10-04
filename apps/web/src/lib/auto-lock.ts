import { useEffect } from "react";
import { post } from "./api";
import { useSession } from "./session";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Locks the vault after the user's chosen idle time. "Immediately" (0) locks
 * whenever the app is hidden. The server enforces its own window as well, so
 * a client that never locks still loses access.
 */
export function useAutoLock() {
  const status = useSession((s) => s.status);
  const minutes = useSession((s) => s.me?.user.autoLockMinutes ?? 15);
  const lock = useSession((s) => s.lock);

  useEffect(() => {
    if (status !== "unlocked") return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, touch, { passive: true });

    const onVisibility = () => {
      if (document.visibilityState === "hidden" && minutes === 0) void lock();
      // Coming back after a long time away (laptop asleep): check at once.
      if (
        document.visibilityState === "visible" &&
        minutes > 0 &&
        Date.now() - last > minutes * 60_000
      )
        void lock();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // The desktop shell reports its window losing focus.
    const onDesktopBlur = () => {
      if (minutes === 0) void lock();
    };
    window.addEventListener("minions:blur", onDesktopBlur);

    let lastBeat = Date.now();
    const timer = window.setInterval(() => {
      const idle = Date.now() - last;
      if (minutes > 0 && idle > minutes * 60_000) {
        void lock();
        return;
      }
      // Active but not calling the API (reading, typing a long note): keep
      // the server's unlock window in step with the user.
      if (idle < 60_000 && Date.now() - lastBeat > 45_000) {
        lastBeat = Date.now();
        void post("/vault/heartbeat").catch(() => undefined);
      }
    }, 10_000);

    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, touch);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("minions:blur", onDesktopBlur);
      window.clearInterval(timer);
    };
  }, [status, minutes, lock]);
}
