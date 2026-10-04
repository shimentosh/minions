import {
  DEFAULT_PASSWORD_OPTIONS,
  estimateStrength,
  generatePassword,
  type PasswordOptions,
} from "@minions/core";
import { Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { StrengthBar } from "@/components/auth/auth-screens";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { copySecret } from "@/lib/clipboard";

const OPTIONS_KEY = "minions-generator-options";

function loadOptions(): PasswordOptions {
  try {
    // Only the generator's settings are remembered, never a generated value.
    const raw = localStorage.getItem(OPTIONS_KEY);
    return raw
      ? { ...DEFAULT_PASSWORD_OPTIONS, ...(JSON.parse(raw) as Partial<PasswordOptions>) }
      : DEFAULT_PASSWORD_OPTIONS;
  } catch {
    return DEFAULT_PASSWORD_OPTIONS;
  }
}

export function PasswordGenerator({
  onUse,
  useLabel = "Use password",
}: {
  onUse?: (password: string) => void;
  useLabel?: string;
}) {
  const [options, setOptions] = useState<PasswordOptions>(loadOptions);
  const [password, setPassword] = useState("");

  const regenerate = useCallback(() => {
    try {
      setPassword(generatePassword(options));
    } catch {
      setPassword("");
    }
  }, [options]);

  useEffect(() => {
    regenerate();
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      /* private mode */
    }
  }, [options, regenerate]);

  const toggles: [keyof PasswordOptions, string][] = [
    ["uppercase", "A–Z"],
    ["lowercase", "a–z"],
    ["numbers", "0–9"],
    ["symbols", "!@#"],
    ["avoidAmbiguous", "Avoid look-alikes"],
  ];
  const enabledSets = (["uppercase", "lowercase", "numbers", "symbols"] as const).filter(
    (k) => options[k],
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
        <code className="secret-text min-w-0 flex-1 text-base">
          {password || "Select at least one character set"}
        </code>
        <Button variant="ghost" size="icon-sm" onClick={regenerate} aria-label="Generate another">
          <RefreshCw />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => password && void copySecret(password, { label: "Password" })}
          aria-label="Copy password"
        >
          <Copy />
        </Button>
      </div>
      <StrengthBar password={password} />
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Length</Label>
          <span className="font-medium text-sm tabular-nums">{options.length}</span>
        </div>
        <Slider
          min={8}
          max={64}
          value={options.length}
          onValueChange={(v) =>
            setOptions((o) => ({ ...o, length: Array.isArray(v) ? v[0]! : (v as number) }))
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {toggles.map(([key, label]) => (
          <label
            key={key}
            className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
          >
            {label}
            <Switch
              checked={!!options[key]}
              disabled={key !== "avoidAmbiguous" && !!options[key] && enabledSets === 1}
              onCheckedChange={(checked) => setOptions((o) => ({ ...o, [key]: checked }))}
            />
          </label>
        ))}
      </div>
      {onUse && (
        <Button className="w-full" onClick={() => password && onUse(password)} disabled={!password}>
          {useLabel}
        </Button>
      )}
      <p className="text-muted-foreground text-xs">
        Generated on this device with the system's secure random source. Entropy ≈{" "}
        {estimateStrength(password).entropyBits} bits.
      </p>
    </div>
  );
}
