import type {
  PeoplePermission,
  PeopleShare,
  PeopleShareStatus,
  ShareRecipientLookup,
  VaultItemDetail,
} from "@minions/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  KeyRound,
  Lock,
  Mail,
  MailWarning,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { SimpleSelect } from "@/components/simple-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { MemberAvatar } from "@/components/workspaces/member-avatar";
import { ApiError, del, errorMessage, get, patch } from "@/lib/api";
import { shortDate } from "@/lib/format";
import {
  fingerprintOf,
  lookupRecipient,
  setNewItemKey,
  shareWithPerson,
} from "@/lib/people-sharing";
import { useInvalidateVault } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

export const PERMISSION_OPTIONS: { value: PeoplePermission; label: string }[] = [
  { value: "VIEW", label: "Can view" },
  { value: "EDIT", label: "Can edit" },
];

export const PEOPLE_EXPIRY_OPTIONS = [
  { value: "0", label: "Never expires" },
  { value: "60", label: "1 hour" },
  { value: "1440", label: "1 day" },
  { value: "10080", label: "7 days" },
  { value: "43200", label: "30 days" },
  { value: "129600", label: "90 days" },
];

export const PEOPLE_STATUS: Record<
  PeopleShareStatus,
  { label: string; hint: string; variant: "success" | "info" | "warning" | "outline" }
> = {
  active: { label: "Has access", hint: "", variant: "success" },
  ready: {
    label: "Handing over",
    hint: "They've joined. Your app hands over the key automatically.",
    variant: "info",
  },
  invited: {
    label: "Invite sent",
    hint: "Gets it after creating an account with this email.",
    variant: "warning",
  },
  expired: { label: "Expired", hint: "No longer has access.", variant: "outline" },
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function usePeopleShares(itemId: string) {
  return useQuery({
    queryKey: ["people", itemId],
    queryFn: () => get<PeopleShare[]>(`/vault/items/${itemId}/people`),
  });
}

/** What happens if you share with this address: someone on Minions, or an invitation. */
function RecipientHint({ email }: { email: string }) {
  const [debounced, setDebounced] = useState(email);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(email), 400);
    return () => window.clearTimeout(t);
  }, [email]);
  const valid = EMAIL.test(debounced);
  const lookup = useQuery({
    queryKey: ["people-lookup", debounced.toLowerCase()],
    enabled: valid,
    staleTime: 60_000,
    retry: false,
    queryFn: () => lookupRecipient(debounced),
  });
  const fingerprint = useQuery({
    queryKey: ["fingerprint", lookup.data?.recipient?.publicKey],
    enabled: !!lookup.data?.recipient,
    queryFn: () => fingerprintOf(lookup.data!.recipient!.publicKey),
  });
  if (!valid || debounced !== email) return null;
  if (lookup.isLoading) return <Skeleton className="h-9" />;
  if (lookup.error)
    return (
      <p className="flex items-center gap-1.5 text-destructive-foreground text-xs">
        <MailWarning className="size-3.5 shrink-0" /> {errorMessage(lookup.error)}
      </p>
    );
  const r = (lookup.data as ShareRecipientLookup | undefined)?.recipient;
  return r ? (
    <div className="rounded-lg bg-success/8 px-3 py-2 text-success-foreground text-xs dark:bg-success/16">
      <p className="flex items-center gap-1.5 font-medium">
        <CheckCircle2 className="size-3.5 shrink-0" /> {r.name} is on Minions. They get it right
        away.
      </p>
      {fingerprint.data && (
        <p className="mt-1 text-success-foreground/80">
          Their security code: <span className="font-mono">{fingerprint.data}</span>. To be sure,
          ask them for the code on their Shared page.
        </p>
      )}
    </div>
  ) : (
    <p className="flex items-start gap-1.5 rounded-lg bg-info/8 px-3 py-2 text-info-foreground text-xs dark:bg-info/16">
      <Mail className="mt-px size-3.5 shrink-0" />
      Not on Minions yet. We'll email an invitation, and they get it once they've signed up with
      this address.
    </p>
  );
}

function ShareRow({
  share,
  onChanged,
}: {
  share: PeopleShare;
  onChanged: (removed?: { rekeyNeeded: boolean }) => void;
}) {
  const status = PEOPLE_STATUS[share.status];
  const update = useMutation({
    mutationFn: (permission: string) =>
      patch(`/vault/items/${share.itemId}/people/${share.id}`, { permission }),
    onSuccess: () => onChanged(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () =>
      del<{ rekeyNeeded: boolean }>(`/vault/items/${share.itemId}/people/${share.id}`),
    onSuccess: (r) => onChanged(r ?? { rekeyNeeded: false }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const name = share.recipient?.name ?? share.email;
  return (
    <div className="flex items-center gap-2.5 py-2">
      <MemberAvatar name={name} className="size-8" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-sm">{name}</span>
          <Badge variant={status.variant} size="sm" title={status.hint || undefined}>
            {status.label}
          </Badge>
        </div>
        <div className="truncate text-muted-foreground text-xs">
          {share.recipient ? `${share.email} · ` : ""}
          {share.expiresAt
            ? `${share.status === "expired" ? "expired" : "until"} ${shortDate(share.expiresAt)}`
            : "no end date"}
        </div>
      </div>
      <SimpleSelect
        size="sm"
        className="w-28"
        value={share.permission}
        onChange={(v) => update.mutate(v)}
        options={PERMISSION_OPTIONS}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Stop sharing with ${name}`}
        title="Stop sharing"
        loading={remove.isPending}
        onClick={() => remove.mutate()}
      >
        <X />
      </Button>
    </div>
  );
}

/**
 * The "People" tab of the share dialog: add someone by email, see who has
 * access and in what state, change or remove it.
 */
export function PeopleSharePanel({ item }: { item: VaultItemDetail }) {
  const me = useSession((s) => s.me);
  const qc = useQueryClient();
  const invalidate = useInvalidateVault();
  const shares = usePeopleShares(item.id);
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<PeoplePermission>("VIEW");
  const [expiry, setExpiry] = useState("0");
  const [busy, setBusy] = useState(false);
  const [rekeying, setRekeying] = useState(false);

  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ["people", item.id] }), invalidate()]);

  async function relock(quiet = false) {
    setRekeying(true);
    try {
      await setNewItemKey(item.id);
      if (!quiet) toast.success("Re-locked with a new key");
    } catch (e) {
      toast.error("Couldn't replace the key", errorMessage(e));
    } finally {
      setRekeying(false);
      void refresh();
    }
  }

  async function share() {
    const clean = email.trim().toLowerCase();
    if (!EMAIL.test(clean)) return;
    setBusy(true);
    try {
      const s = await shareWithPerson(item, {
        email: clean,
        permission,
        expiresInMinutes: Number(expiry),
      });
      toast.success(
        s.status === "active"
          ? `Shared with ${s.recipient?.name ?? clean}`
          : `Invite sent to ${clean}`,
        s.status === "active"
          ? undefined
          : "They'll get it once they've signed up and you next open Minions.",
      );
      setEmail("");
      void refresh();
    } catch (e) {
      toast.error(
        errorMessage(e),
        e instanceof ApiError && e.code === "REVISION_CONFLICT"
          ? "Close and reopen the item, then share again."
          : undefined,
      );
    } finally {
      setBusy(false);
    }
  }

  function onChanged(removed?: { rekeyNeeded: boolean }) {
    void refresh();
    // They may have kept the key: replace it so nothing they hold opens the item any more.
    if (removed?.rekeyNeeded) {
      void relock(true).then(() =>
        toast.info(
          "Access removed",
          "The item has a new key. They may have copied the password before, so consider changing it.",
        ),
      );
    } else if (removed) toast.success("Invitation cancelled");
  }

  if (me && !me.user.emailVerified)
    return (
      <div className="flex gap-2 rounded-lg bg-warning/8 px-3 py-3 text-sm text-warning-foreground">
        <MailWarning className="mt-0.5 size-4 shrink-0" />
        <span>
          Confirm your email address first: people you share with need to know it's really you. Use
          the link we sent to <strong>{me.user.email}</strong>.
        </span>
      </div>
    );

  const list = shares.data ?? [];
  return (
    <div className="space-y-4">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void share();
        }}
      >
        <Label htmlFor="share-email">Share with</Label>
        <div className="flex gap-1.5">
          <Input
            id="share-email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className="flex-1"
          />
          <Button type="submit" loading={busy} disabled={!EMAIL.test(email.trim())}>
            <UserPlus /> Share
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <SimpleSelect
            size="sm"
            value={permission}
            onChange={(v) => setPermission(v as PeoplePermission)}
            options={PERMISSION_OPTIONS}
          />
          <SimpleSelect
            size="sm"
            value={expiry}
            onChange={setExpiry}
            options={PEOPLE_EXPIRY_OPTIONS}
          />
        </div>
        <RecipientHint email={email.trim().toLowerCase()} />
      </form>

      {item.rekeyNeeded && (
        <div className="flex items-center gap-2 rounded-lg bg-warning/8 px-3 py-2 text-warning-foreground text-xs">
          <KeyRound className="size-3.5 shrink-0" />
          <span className="flex-1">Someone lost access. Give the item a new key.</span>
          <Button size="xs" variant="outline" loading={rekeying} onClick={() => void relock()}>
            <RefreshCw /> Re-lock
          </Button>
        </div>
      )}

      <div>
        <h4 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          People with access
        </h4>
        <div className="divide-y divide-border/60">
          <div className="flex items-center gap-2.5 py-2">
            <MemberAvatar name={me?.user.name ?? "You"} className="size-8" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">{me?.user.name} (you)</div>
              <div className="truncate text-muted-foreground text-xs">{me?.user.email}</div>
            </div>
            <span className="pr-1 text-muted-foreground text-xs">Owner</span>
          </div>
          {shares.isLoading && <Skeleton className="my-2 h-10" />}
          {list.map((s) => (
            <ShareRow key={s.id} share={s} onChanged={onChanged} />
          ))}
        </div>
        {!shares.isLoading && list.length === 0 && (
          <p className="pt-1 text-muted-foreground text-xs">Only you can open this item.</p>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
        <span className="flex items-center gap-1">
          <Lock className="size-3" /> End-to-end encrypted
        </span>
        <span className="flex items-center gap-1">
          <ShieldCheck className="size-3" /> Minions' server can't read it
        </span>
        <span className="flex items-center gap-1">
          <Clock className="size-3" /> Remove access any time
        </span>
      </div>
    </div>
  );
}
