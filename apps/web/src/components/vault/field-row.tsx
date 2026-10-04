import {
  estimateStrength,
  getItemType,
  type ItemField,
  maskCard,
  resolveField,
} from "@minions/core";
import { Copy, ExternalLink, Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import { copySecret } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { fieldIcon } from "@/lib/field-icons";
import { itemPath } from "@/lib/item-keys";
import { toast } from "@/lib/toast";
import { revealField } from "@/lib/vault-crypto";
import { TotpCode } from "./totp-code";

const MASK = "••••••••••••";

function formatCard(n: string) {
  return n
    .replace(/\D/g, "")
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

/**
 * One field of an item. Sensitive values stay ciphertext until the user
 * reveals or copies them, are decrypted for that moment, and are forgotten
 * when the row unmounts.
 */
export function FieldRow({
  itemId,
  type,
  field,
  cardLast4,
}: {
  itemId: string;
  type: string;
  field: ItemField;
  cardLast4?: string | null;
}) {
  const resolved = resolveField(
    type,
    field.key,
    field.label ? { label: field.label, sensitive: field.sensitive, kind: field.kind } : undefined,
  );
  const def = resolved?.def;
  const kind = def?.kind ?? "text";
  const label = def?.label ?? field.label ?? field.key;
  const [plain, setPlain] = useState<string | null>(field.sensitive ? null : field.value);
  const [revealed, setRevealed] = useState(!field.sensitive);

  // A TOTP secret is decrypted to compute codes, never shown.
  useEffect(() => {
    if (kind === "totp" && field.sensitive) {
      revealField(itemId, field).then(setPlain, () =>
        toast.error("Couldn't decrypt the 2FA secret"),
      );
    }
  }, [kind, field, itemId]);

  async function decrypt(): Promise<string | null> {
    if (plain !== null) return plain;
    try {
      const v = await revealField(itemId, field);
      setPlain(v);
      return v;
    } catch {
      toast.error("Couldn't decrypt this field", "It may have been changed outside Minions.");
      return null;
    }
  }

  async function toggleReveal() {
    if (revealed) {
      setRevealed(false);
      if (field.sensitive) setPlain(null);
      return;
    }
    const v = await decrypt();
    if (v === null) return;
    setRevealed(true);
    void post(`${itemPath(itemId)}/usage`, { action: "item.revealed", field: field.key }).catch(
      () => undefined,
    );
  }

  async function copy() {
    const v = await decrypt();
    if (v === null) return;
    await copySecret(kind === "card-number" ? v.replace(/\D/g, "") : v, {
      label,
      itemId,
      field: field.key,
      sensitive: field.sensitive,
    });
    if (!revealed && field.sensitive) setPlain(null);
  }

  const multiline = kind === "multiline" || kind === "code";
  let display: React.ReactNode;
  if (kind === "totp") {
    display = plain ? (
      <TotpCode secret={plain} itemId={itemId} />
    ) : (
      <span className="text-muted-foreground">…</span>
    );
  } else if (!revealed) {
    display = (
      <span className="secret-text text-muted-foreground">
        {kind === "card-number" ? maskCard(cardLast4) : MASK}
      </span>
    );
  } else if (kind === "url" && plain) {
    const href = /^https?:\/\//i.test(plain) ? plain : `https://${plain}`;
    display = (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 break-all text-foreground underline-offset-4 hover:underline"
      >
        {plain} <ExternalLink className="size-3 opacity-60" />
      </a>
    );
  } else if (kind === "card-number" && plain) {
    display = <span className="secret-text">{formatCard(plain)}</span>;
  } else if (multiline) {
    display = (
      <pre
        className={cn(
          "max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-[13px]",
          field.sensitive && "secret-text",
        )}
      >
        {plain}
      </pre>
    );
  } else {
    display = <span className={cn("break-all", field.sensitive && "secret-text")}>{plain}</span>;
  }

  const typeDef = getItemType(type);
  const FieldIcon = fieldIcon({ key: field.key, kind });
  const isPassword = typeDef?.passwordField === field.key;

  return (
    <div className="group flex items-start gap-3 border-border/60 border-b px-4 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <FieldIcon className="size-3.5" aria-hidden />
          {label}
          {isPassword && revealed && plain && <StrengthBadge password={plain} />}
        </div>
        <div className="mt-0.5 min-h-5 text-sm">{display}</div>
      </div>
      {kind !== "totp" && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100 touch:opacity-100">
          {field.sensitive && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={toggleReveal}
              aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
            >
              {revealed ? <EyeOff /> : <Eye />}
            </Button>
          )}
          <Button variant="ghost" size="icon-xs" onClick={copy} aria-label={`Copy ${label}`}>
            <Copy />
          </Button>
        </div>
      )}
    </div>
  );
}

function StrengthBadge({ password }: { password: string }) {
  const s = estimateStrength(password);
  const variant = s.score <= 1 ? "error" : s.score === 2 ? "warning" : "success";
  return (
    <Badge variant={variant} size="sm">
      {s.label}
    </Badge>
  );
}
