import { generateTotp, parseTotp, type TotpConfig } from "@minions/core";
import { Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { copySecret } from "@/lib/clipboard";
import { cn } from "@/lib/cn";

/**
 * The current one-time code, regenerated every period. The TOTP secret stays
 * in this component's memory while it is mounted and is never rendered.
 */
export function TotpCode({
  secret,
  itemId,
  compact = false,
}: {
  secret: string;
  itemId?: string;
  compact?: boolean;
}) {
  const config = useMemo<TotpConfig | null>(() => {
    try {
      return parseTotp(secret);
    } catch {
      return null;
    }
  }, [secret]);
  const [state, setState] = useState<{ code: string; remaining: number; period: number } | null>(
    null,
  );

  useEffect(() => {
    if (!config) return;
    let alive = true;
    const tick = async () => {
      const next = await generateTotp(config);
      if (alive) setState(next);
    };
    void tick();
    const t = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [config]);

  if (!config)
    return <span className="text-destructive-foreground text-sm">Invalid TOTP secret</span>;
  if (!state) return <span className="text-muted-foreground text-sm">…</span>;

  const half = Math.ceil(state.code.length / 2);
  const pct = (state.remaining / state.period) * 100;
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        title="Copy code"
        onClick={() => void copySecret(state.code, { label: "Code", itemId, field: "totp" })}
        className={cn(
          "rounded-md font-mono font-semibold tabular-nums tracking-wider transition-colors hover:text-primary/80",
          compact ? "text-base" : "text-2xl",
        )}
      >
        {state.code.slice(0, half)} {state.code.slice(half)}
      </button>
      <span
        className="relative flex size-6 items-center justify-center"
        title={`Expires in ${state.remaining} seconds`}
      >
        <svg viewBox="0 0 36 36" className="-rotate-90 absolute inset-0" aria-hidden="true">
          <circle cx="18" cy="18" r="15" fill="none" className="stroke-muted" strokeWidth="4" />
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            className={cn(
              "transition-[stroke-dashoffset] duration-1000 ease-linear",
              state.remaining <= 5 ? "stroke-red-500" : "stroke-emerald-500",
            )}
            strokeDasharray={94.25}
            strokeDashoffset={94.25 * (1 - pct / 100)}
          />
        </svg>
        <span className="relative font-medium text-[9px] tabular-nums">{state.remaining}</span>
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => void copySecret(state.code, { label: "Code", itemId, field: "totp" })}
        aria-label="Copy code"
      >
        <Copy />
      </Button>
    </div>
  );
}
