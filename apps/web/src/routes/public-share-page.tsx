import {
  decryptSharePayload,
  deriveShareKeys,
  fromBase64Url,
  type ShareMeta,
  type SharePayload,
} from "@minions/core";
import { Clock, Copy, Eye, EyeOff, Lock, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { PasswordInput } from "@/components/auth/auth-screens";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { TotpCode } from "@/components/vault/totp-code";
import { ApiError, errorMessage, get, post } from "@/lib/api";
import { copySecret } from "@/lib/clipboard";
import { fieldIcon } from "@/lib/field-icons";
import { ItemGlyph } from "@/lib/item-icons";

function until(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `in ${Math.floor(h / 24)} days`;
  if (h >= 1) return `in ${h} hour${h === 1 ? "" : "s"}`;
  return `in ${Math.max(1, Math.floor(ms / 60_000))} minutes`;
}

function SharedField({ field }: { field: SharePayload["fields"][number] }) {
  const [shown, setShown] = useState(!field.sensitive);
  const Icon = fieldIcon({ key: field.label.toLowerCase(), kind: (field.kind as never) ?? "text" });
  const multiline =
    field.value.includes("\n") || field.kind === "code" || field.kind === "multiline";
  return (
    <div className="flex items-start gap-3 border-border/60 border-b px-4 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <Icon className="size-3.5" /> {field.label}
        </div>
        {shown ? (
          multiline ? (
            <pre className="secret-text mt-0.5 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-[13px]">
              {field.value}
            </pre>
          ) : (
            <div className="secret-text mt-0.5 text-sm">{field.value}</div>
          )
        ) : (
          <div className="secret-text mt-0.5 text-muted-foreground text-sm">••••••••••••</div>
        )}
      </div>
      <div className="flex shrink-0 gap-0.5">
        {field.sensitive && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? "Hide" : "Show"}
          >
            {shown ? <EyeOff /> : <Eye />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() =>
            void copySecret(field.value, { label: field.label, sensitive: field.sensitive })
          }
          aria-label={`Copy ${field.label}`}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

/**
 * What the recipient of a share link sees. No account needed. Nothing is
 * fetched until "Reveal" (link previews in chat apps don't burn one-time
 * links), and the key from the #fragment never leaves this page.
 */
export function PublicSharePage() {
  const id = window.location.pathname.split("/")[2] ?? "";
  const [linkKey] = useState(() => {
    const k = window.location.hash.slice(1);
    // Take the key out of the address bar and history once read.
    if (k) window.history.replaceState(null, "", window.location.pathname);
    return k;
  });
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [viewsLeft, setViewsLeft] = useState<number | null>(null);

  useEffect(() => {
    document.title = "Shared with you · Minions";
    get<ShareMeta>(`/public/shares/${id}`).then(setMeta, (e) => setError(errorMessage(e)));
  }, [id]);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const key = fromBase64Url(linkKey);
      const keys = await deriveShareKeys(
        key,
        meta?.requiresPassphrase && meta.passphraseSalt
          ? { value: passphrase, salt: meta.passphraseSalt }
          : undefined,
      );
      const res = await post<{ ciphertext: string; viewsLeft: number | null }>(
        `/public/shares/${id}/open`,
        keys.accessToken ? { accessToken: keys.accessToken } : {},
      );
      setPayload(await decryptSharePayload(keys.encKey, id, res.ciphertext));
      setViewsLeft(res.viewsLeft);
      keys.encKey.fill(0);
    } catch (e) {
      if (e instanceof ApiError && e.code === "BAD_PASSPHRASE") setError(e.message);
      else if (e instanceof Error && e.name === "DecryptionError")
        setError("This link is damaged: part of it may be missing.");
      else setError(errorMessage(e));
      if (e instanceof ApiError && e.status === 404)
        setMeta((m) => (m ? { ...m, available: false } : m));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full w-full flex-col items-center overflow-y-auto bg-background px-gutter py-10">
      <div className="my-auto w-full max-w-md space-y-4">
        <div className="flex items-center justify-center gap-2">
          <img src="/minions.svg" alt="" className="size-8 rounded-lg" />
          <span className="font-semibold text-lg tracking-tight">Minions</span>
        </div>
        <Card>
          {payload ? (
            <>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2.5 text-lg">
                  <ItemGlyph type={payload.type} /> {payload.name}
                </CardTitle>
                <CardDescription>
                  {payload.sharedBy ? `Shared by ${payload.sharedBy}` : "Shared with you"}
                </CardDescription>
              </CardHeader>
              <CardPanel className="space-y-3 pt-0">
                {payload.message && (
                  <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm">{payload.message}</p>
                )}
                <div className="rounded-xl border">
                  {payload.fields.map((f) => (
                    <SharedField key={f.label} field={f} />
                  ))}
                  {payload.totp && (
                    <div className="px-4 py-2.5">
                      <div className="mb-1 text-muted-foreground text-xs">2FA code</div>
                      <TotpCode secret={payload.totp} />
                    </div>
                  )}
                </div>
                <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  {viewsLeft === 0
                    ? "This was the last view: the link no longer works. Copy what you need now."
                    : "Copy what you need now. This page does not keep it."}
                </p>
              </CardPanel>
            </>
          ) : (
            <>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Lock className="size-4" /> Someone shared a secret with you
                </CardTitle>
                <CardDescription>
                  It is end-to-end encrypted: only this link can open it.
                </CardDescription>
              </CardHeader>
              <CardPanel className="space-y-4 pt-0">
                {!linkKey && (
                  <p className="text-destructive-foreground text-sm">
                    This link is incomplete. Ask the sender for the full link.
                  </p>
                )}
                {meta && !meta.available && (
                  <p className="rounded-lg bg-muted px-3 py-2 text-sm">
                    {meta.reason === "revoked"
                      ? "The sender has revoked this link."
                      : meta.reason === "expired"
                        ? "This link has expired."
                        : "This link has already been opened and no longer works."}
                  </p>
                )}
                {meta?.available && linkKey && (
                  <>
                    <div className="flex flex-wrap gap-3 text-muted-foreground text-xs">
                      <span className="flex items-center gap-1">
                        <Clock className="size-3.5" />{" "}
                        {meta.expiresAt ? `Expires ${until(meta.expiresAt)}` : "Never expires"}
                      </span>
                      <span className="flex items-center gap-1">
                        <Eye className="size-3.5" />
                        {meta.viewsLeft === null
                          ? meta.expiresAt
                            ? "Can be opened until then"
                            : "Can be opened until the sender revokes it"
                          : meta.viewsLeft === 1
                            ? "Can be opened once"
                            : `${meta.viewsLeft} views left`}
                      </span>
                    </div>
                    {meta.requiresPassphrase && (
                      <PasswordInput
                        id="share-passphrase"
                        value={passphrase}
                        onChange={setPassphrase}
                        placeholder="Passphrase from the sender"
                        autoComplete="off"
                      />
                    )}
                    <Button
                      className="w-full"
                      onClick={() => void reveal()}
                      loading={busy}
                      disabled={meta.requiresPassphrase && !passphrase}
                    >
                      <ShieldCheck /> Reveal{meta.viewsLeft === 1 ? " (one-time)" : ""}
                    </Button>
                  </>
                )}
                {error && <p className="text-destructive-foreground text-sm">{error}</p>}
              </CardPanel>
            </>
          )}
        </Card>
        <p className="text-center text-muted-foreground text-xs">
          Decrypted in your browser. Minions' server never sees the contents.
        </p>
      </div>
    </div>
  );
}
