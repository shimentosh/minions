import type { ShareSummary } from "@minions/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { KeyRound, Link2, Lock, Plus, Timer } from "lucide-react";
import { useState } from "react";
import { PasswordInput } from "@/components/auth/auth-screens";
import { EmptyNote, Page, PageBody, Section } from "@/components/layout/page";
import { SimpleSelect } from "@/components/simple-select";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  createShareLink,
  EXPIRY_OPTIONS,
  ShareResult,
  VIEW_OPTIONS,
} from "@/components/vault/share-dialog";
import { del, errorMessage, get } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

const STATUS: Record<
  ShareSummary["status"],
  { label: string; variant: "success" | "secondary" | "outline" | "error" }
> = {
  active: { label: "Active", variant: "success" },
  used: { label: "Used up", variant: "secondary" },
  expired: { label: "Expired", variant: "outline" },
  revoked: { label: "Revoked", variant: "error" },
};

/** A one-off secret that isn't saved in the vault: a password to send, a code… */
function ShareTextDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const me = useSession((s) => s.me);
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [expiry, setExpiry] = useState("1440");
  const [views, setViews] = useState("1");
  const [usePass, setUsePass] = useState(false);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    try {
      const res = await createShareLink({
        payload: {
          v: 1,
          name: title.trim() || "Secret",
          type: "SECURE_NOTE",
          fields: [{ label: "Secret", value: text, kind: "multiline", sensitive: true }],
          ...(me ? { sharedBy: me.user.name } : {}),
        },
        label: title.trim() || "Text",
        expiresInMinutes: Number(expiry),
        maxViews: views === "0" ? null : Number(views),
        passphrase: usePass ? pass : undefined,
      });
      setUrl(res.url);
      setText("");
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
            <Lock className="size-4" /> Share a secret
          </DialogTitle>
          <DialogDescription>
            Paste anything: a password, a key, a note. It is encrypted here and not saved in your
            vault.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {url ? (
            <ShareResult
              url={url}
              passphrase={usePass ? pass : undefined}
              onDone={() => onOpenChange(false)}
            />
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="st-title">Title</Label>
                <Input
                  id="st-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Staging database password"
                  maxLength={120}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="st-text">Secret</Label>
                <Textarea
                  id="st-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={4}
                  className="font-mono text-[13px]"
                  spellCheck={false}
                />
              </div>
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
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={usePass} onCheckedChange={setUsePass} /> Also require a passphrase
              </label>
              {usePass && (
                <PasswordInput
                  id="st-pass"
                  value={pass}
                  onChange={setPass}
                  placeholder="Passphrase to send separately"
                  autoComplete="off"
                />
              )}
            </>
          )}
        </DialogPanel>
        {!url && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              loading={busy}
              disabled={!text.trim() || (usePass && pass.length < 4)}
            >
              <Link2 /> Create link
            </Button>
          </DialogFooter>
        )}
      </DialogPopup>
    </Dialog>
  );
}

export function SharesPage() {
  const qc = useQueryClient();
  const [textOpen, setTextOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["shares"],
    queryFn: () => get<ShareSummary[]>("/shares"),
    refetchInterval: 30_000,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/shares/${id}`),
    onSuccess: () => {
      toast.success("Link revoked", "It stops working immediately.");
      void qc.invalidateQueries({ queryKey: ["shares"] });
    },
  });
  const active = data?.filter((s) => s.status === "active") ?? [];
  const past = data?.filter((s) => s.status !== "active") ?? [];

  const row = (s: ShareSummary) => (
    <div
      key={s.id}
      className="flex items-center gap-3 border-border/60 border-b py-2.5 last:border-b-0"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Link2 className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm">
          {s.itemId ? (
            <Link
              to="/vault"
              search={{ item: s.itemId }}
              className="truncate font-medium hover:underline"
            >
              {s.label}
            </Link>
          ) : (
            <span className="truncate font-medium">{s.label}</span>
          )}
          <Badge variant={STATUS[s.status].variant} size="sm">
            {STATUS[s.status].label}
          </Badge>
          {s.requiresPassphrase && (
            <KeyRound className="size-3.5 text-muted-foreground" aria-label="Passphrase" />
          )}
          {s.includesTotp && (
            <Timer className="size-3.5 text-muted-foreground" aria-label="Includes 2FA" />
          )}
        </div>
        <div className="text-muted-foreground text-xs">
          Opened {s.viewCount}
          {s.maxViews !== null ? ` of ${s.maxViews}` : ""} time{s.viewCount === 1 ? "" : "s"}
          {s.lastViewedAt ? ` · last ${timeAgo(s.lastViewedAt)}` : ""} ·{" "}
          {s.status === "active"
            ? s.expiresAt
              ? `expires ${new Date(s.expiresAt).toLocaleString()}`
              : "never expires"
            : `created ${timeAgo(s.createdAt)}`}
        </div>
      </div>
      {s.status === "active" && (
        <Button size="xs" variant="destructive-outline" onClick={() => revoke.mutate(s.id)}>
          Revoke
        </Button>
      )}
    </div>
  );

  return (
    <Page title="Shared links">
      <PageBody
        title="Shared links"
        subtitle="Links you sent from your vault. The server only ever holds them encrypted; expired, used and revoked links are wiped."
        actions={
          <Button size="sm" onClick={() => setTextOpen(true)}>
            <Plus /> Share a secret
          </Button>
        }
      >
        {isLoading && <Skeleton className="h-32 rounded-xl" />}
        <Section title={`Active · ${active.length}`} hint="Open an item and press Share to send it">
          {active.length ? active.map(row) : <EmptyNote>No active links.</EmptyNote>}
        </Section>
        {past.length > 0 && <Section title="Past links">{past.map(row)}</Section>}
      </PageBody>
      <ShareTextDialog open={textOpen} onOpenChange={setTextOpen} />
    </Page>
  );
}
