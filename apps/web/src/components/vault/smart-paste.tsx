import { getItemType, resolveField, type SmartFillResult, smartFill } from "@minions/core";
import { ClipboardPaste, ImageUp, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { decodeQrImage } from "@/lib/qr";
import { toast } from "@/lib/toast";

/**
 * "Paste anything": a website, an email, a password, `label: value` lines,
 * a .env block, or a screenshot of a 2FA QR code. Everything is parsed on this
 * device and dropped into the right fields; nothing is sent anywhere.
 */
export function SmartPaste({
  type,
  onFill,
}: {
  type?: string;
  onFill: (r: SmartFillResult) => void;
}) {
  const [text, setText] = useState("");
  const [filled, setFilled] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  function apply(raw: string) {
    if (!raw.trim()) return;
    const r = smartFill(raw, type || undefined);
    if (!r.filled.length && !r.name) {
      toast.info("Couldn't recognise anything", "Try one value per line, like “User: name”.");
      return;
    }
    onFill(r);
    const labels = r.filled.map(
      (k) =>
        resolveField(r.type, k, { label: k.replace(/^var\./, ""), sensitive: true })?.def.label ??
        k,
    );
    setFilled(r.name && !r.filled.includes("name") ? ["Name", ...labels] : labels);
    // The pasted text may hold secrets; it does not stay on screen.
    setText("");
  }

  async function fromImage(blob: Blob) {
    try {
      const data = await decodeQrImage(blob);
      if (!data) return toast.error("No QR code found in that image");
      if (data.startsWith("otpauth-migration://")) {
        return toast.info(
          "That's a Google Authenticator export",
          "Open Authenticator → Import to bring over all accounts at once.",
        );
      }
      if (!data.toLowerCase().startsWith("otpauth://")) return apply(data);
      const t = type && getItemType(type)?.fields.some((f) => f.key === "totp") ? type : "TOTP";
      const label = decodeURIComponent(new URL(data).pathname.slice(1));
      const issuer = new URL(data).searchParams.get("issuer") ?? label.split(":")[0];
      onFill({ type: t, values: { totp: data }, name: issuer || undefined, filled: ["totp"] });
      setFilled(["2FA secret (from QR code)"]);
    } catch {
      toast.error("Couldn't read that image");
    }
  }

  return (
    <div className="space-y-1.5 rounded-xl border border-primary/25 border-dashed bg-primary/[0.03] p-3">
      <div className="flex items-center gap-2 font-medium text-sm">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/10">
          <Sparkles className="size-3.5" />
        </span>
        Paste anything
        <span className="font-normal text-muted-foreground text-xs">
          website, email, password, 2FA QR screenshot…
        </span>
      </div>
      <div className="flex gap-1.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const image = [...e.clipboardData.items]
              .find((i) => i.type.startsWith("image/"))
              ?.getAsFile();
            if (image) {
              e.preventDefault();
              void fromImage(image);
              return;
            }
            const pasted = e.clipboardData.getData("text");
            if (pasted) {
              e.preventDefault();
              apply(pasted);
            }
          }}
          rows={2}
          spellCheck={false}
          placeholder={"github.com  me@gmail.com  myPassw0rd!\nUser: octo   Pass: …   2FA: JBSW…"}
          className="min-h-14 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 font-mono text-[13px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
        />
        <div className="flex flex-col gap-1">
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => apply(text)}
            disabled={!text.trim()}
            aria-label="Fill fields"
            title="Fill fields"
          >
            <ClipboardPaste />
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => fileRef.current?.click()}
            aria-label="Scan a QR code image"
            title="Scan a QR code image"
          >
            <ImageUp />
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && void fromImage(e.target.files[0])}
          />
        </div>
      </div>
      {filled.length > 0 && (
        <p className="text-emerald-700 text-xs dark:text-emerald-400">
          Filled: {filled.join(" · ")}. Check them below, then save.
        </p>
      )}
    </div>
  );
}
