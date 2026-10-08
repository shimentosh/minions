import {
  type CreateShareRequest,
  deriveShareKeys,
  encryptSharePayload,
  newShareLinkKey,
  randomBytes,
  resolveField,
  type SharePayload,
  type ShareSummary,
  sha256Hex,
  toBase64,
  toBase64Url,
  type VaultItemDetail,
} from "@minions/core";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, ShieldAlert, Timer, Users } from "lucide-react";
import { useState } from "react";
import { PasswordInput } from "@/components/auth/auth-screens";
import { SimpleSelect } from "@/components/simple-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, post } from "@/lib/api";
import { fieldIcon } from "@/lib/field-icons";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { revealField } from "@/lib/vault-crypto";
import { PeopleSharePanel } from "./people-share-panel";

export const EXPIRY_OPTIONS = [
  { value: "15", label: "15 minutes" },
  { value: "60", label: "1 hour" },
  { value: "1440", label: "1 day" },
  { value: "10080", label: "7 days" },
  { value: "43200", label: "30 days" },
  { value: "0", label: "Never" },
];
export const VIEW_OPTIONS = [
  { value: "1", label: "One view only" },
  { value: "3", label: "3 views" },
  { value: "10", label: "10 views" },
  { value: "0", label: "No limit" },
];

/** Encrypts a payload under a fresh link key, uploads the ciphertext, returns the link. */
export async function createShareLink(opts: {
  payload: SharePayload;
  label: string;
  itemId?: string;
  expiresInMinutes: number;
  maxViews: number | null;
  passphrase?: string;
}): Promise<{ url: string; share: ShareSummary }> {
  const id = crypto.randomUUID();
  const linkKey = newShareLinkKey();
  const salt = opts.passphrase ? toBase64(randomBytes(16)) : undefined;
  const keys = await deriveShareKeys(
    linkKey,
    opts.passphrase && salt ? { value: opts.passphrase, salt } : undefined,
  );
  const body: CreateShareRequest = {
    id,
    itemId: opts.itemId ?? null,
    label: opts.label.slice(0, 120),
    ciphertext: await encryptSharePayload(keys.encKey, id, opts.payload),
    expiresInMinutes: opts.expiresInMinutes,
    maxViews: opts.maxViews,
    includesTotp: !!opts.payload.totp,
    ...(salt && keys.accessToken
      ? { passphraseSalt: salt, accessHash: await sha256Hex(keys.accessToken) }
      : {}),
  };
  const share = await post<ShareSummary>("/shares", body);
  keys.encKey.fill(0);
  // The key goes after "#": browsers never send that part to any server.
  const url = `${window.location.origin}/s/${id}#${toBase64Url(linkKey)}`;
  linkKey.fill(0);
  return { url, share };
}

export function ShareResult({
  url,
  passphrase,
  onDone,
}: {
  url: string;
  passphrase?: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <Input
          readOnly
          value={url}
          className="font-mono text-xs"
          onFocus={(e) => e.target.select()}
        />
        <Button
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            toast.success("Link copied");
          }}
        >
          {copied ? <Check /> : <Copy />} Copy
        </Button>
      </div>
      {passphrase && (
        <p className="rounded-lg bg-warning/8 px-3 py-2 text-warning-foreground text-xs">
          Send the passphrase through a different channel than the link (a call, another app).
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        The key is in the part of the link after “#”. Minions' server never sees it, so it cannot
        read what you shared. You can revoke the link any time in Shared links.
      </p>
      <div className="flex justify-end">
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

export type ShareMode = "people" | "link";

/**
 * Share an item: with people by email (they keep access in their own vault,
 * until you remove it or it expires), or as a one-off link anyone can open.
 */
export function ShareItemDialog({
  item,
  open,
  onOpenChange,
  initialMode = "people",
}: {
  item: VaultItemDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialMode?: ShareMode;
}) {
  const [mode, setMode] = useState<ShareMode>(initialMode);
  const me = useSession((s) => s.me);
  const qc = useQueryClient();
  const shareable = item.fields.filter((f) => f.key !== "totp");
  const hasTotp = item.fields.some((f) => f.key === "totp");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(shareable.filter((f) => f.key !== "notes").map((f) => f.key)),
  );
  const [withTotp, setWithTotp] = useState(false);
  const [expiry, setExpiry] = useState("1440");
  const [views, setViews] = useState("1");
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  const label = (key: string) => {
    const f = item.fields.find((x) => x.key === key)!;
    return (
      resolveField(item.type, key, f.label ? { label: f.label, sensitive: f.sensitive } : undefined)
        ?.def ?? { key, label: key, kind: "text" as const, sensitive: f.sensitive }
    );
  };

  async function create() {
    setBusy(true);
    try {
      // Decrypted here, re-encrypted under the link key, then sent.
      const fields: SharePayload["fields"] = [];
      for (const f of shareable) {
        if (!selected.has(f.key)) continue;
        const def = label(f.key);
        fields.push({
          label: def.label,
          value: await revealField(item.id, f),
          kind: def.kind,
          sensitive: f.sensitive,
        });
      }
      const totpField = item.fields.find((f) => f.key === "totp");
      const payload: SharePayload = {
        v: 1,
        name: item.name,
        type: item.type,
        fields,
        ...(withTotp && totpField ? { totp: await revealField(item.id, totpField) } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(me ? { sharedBy: me.user.name } : {}),
      };
      const res = await createShareLink({
        payload,
        label: item.name,
        itemId: item.id,
        expiresInMinutes: Number(expiry),
        maxViews: views === "0" ? null : Number(views),
        passphrase: usePassphrase ? passphrase : undefined,
      });
      setUrl(res.url);
      void qc.invalidateQueries({ queryKey: ["shares"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setUrl(null);
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === "people" ? <Users className="size-4" /> : <Link2 className="size-4" />} Share
            “{item.name}”
          </DialogTitle>
          <DialogDescription>
            {mode === "people"
              ? "Share with someone by email. It appears in their Minions, stays up to date when you change it, and you can remove it any time."
              : "Anyone with the link can open it, without a Minions account, until it expires or runs out of views."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {!url && (
            <Tabs value={mode} onValueChange={(v) => setMode(v as ShareMode)}>
              <TabsList className="w-full">
                <TabsTab value="people">
                  <Users /> People
                </TabsTab>
                <TabsTab value="link">
                  <Link2 /> Link
                </TabsTab>
              </TabsList>
            </Tabs>
          )}
          {mode === "people" ? (
            <PeopleSharePanel item={item} />
          ) : url ? (
            <ShareResult
              url={url}
              passphrase={usePassphrase ? passphrase : undefined}
              onDone={() => onOpenChange(false)}
            />
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>What to share</Label>
                <div className="space-y-1 rounded-lg border p-2">
                  {shareable.map((f) => {
                    const def = label(f.key);
                    const Icon = fieldIcon(def);
                    return (
                      <label
                        key={f.key}
                        className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/50"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(f.key)}
                          onChange={(e) =>
                            setSelected((s) => {
                              const n = new Set(s);
                              if (e.target.checked) n.add(f.key);
                              else n.delete(f.key);
                              return n;
                            })
                          }
                        />
                        <Icon className="size-3.5 text-muted-foreground" />
                        {def.label}
                      </label>
                    );
                  })}
                </div>
              </div>
              {hasTotp && (
                <div className="space-y-2 rounded-lg border p-3">
                  <label className="flex items-center gap-2 font-medium text-sm">
                    <Switch checked={withTotp} onCheckedChange={setWithTotp} />
                    <Timer className="size-4" /> Include live 2FA codes
                  </label>
                  {withTotp && (
                    <p className="flex gap-1.5 text-warning-foreground text-xs">
                      <ShieldAlert className="mt-px size-3.5 shrink-0" />
                      This shares the 2FA secret itself: whoever opens the link can generate codes
                      for as long as they keep it. Only share it with people you trust with the
                      account.
                    </p>
                  )}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Expires after</Label>
                  <SimpleSelect value={expiry} onChange={setExpiry} options={EXPIRY_OPTIONS} />
                </div>
                <div className="space-y-1.5">
                  <Label>Can be opened</Label>
                  <SimpleSelect value={views} onChange={setViews} options={VIEW_OPTIONS} />
                </div>
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={usePassphrase} onCheckedChange={setUsePassphrase} /> Also require
                  a passphrase
                </label>
                {usePassphrase && (
                  <PasswordInput
                    id="share-pass"
                    value={passphrase}
                    onChange={setPassphrase}
                    placeholder="Passphrase to send separately"
                    autoComplete="off"
                  />
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="share-msg">Message (optional, encrypted)</Label>
                <Textarea
                  id="share-msg"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={2}
                  maxLength={1000}
                  placeholder="Here's the staging login for this week."
                />
              </div>
            </>
          )}
        </DialogPanel>
        {!url && mode === "link" && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              loading={busy}
              disabled={
                (selected.size === 0 && !withTotp) || (usePassphrase && passphrase.length < 4)
              }
            >
              <Link2 /> Create link
            </Button>
          </DialogFooter>
        )}
      </DialogPopup>
    </Dialog>
  );
}
