import {
  getItemType,
  type PeopleShare,
  publicKeyFingerprint,
  type SharedWithMeItem,
} from "@minions/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  Clock,
  Hourglass,
  Inbox,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useMemo } from "react";
import { EmptyNote, Page, PageBody } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { FieldRow } from "@/components/vault/field-row";
import { Block, Meta } from "@/components/vault/item-detail";
import { PEOPLE_STATUS, PERMISSION_OPTIONS } from "@/components/vault/people-share-panel";
import { MemberAvatar } from "@/components/workspaces/member-avatar";
import { del, errorMessage, get } from "@/lib/api";
import { cn } from "@/lib/cn";
import { shortDate, timeAgo } from "@/lib/format";
import { ItemGlyph } from "@/lib/item-icons";
import { loadSharedItem, setNewItemKey } from "@/lib/people-sharing";
import { requireSharingKeys, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useUi } from "@/lib/ui-store";

export interface SharedSearch {
  side?: "by-me";
  item?: string;
}

const permissionLabel = (p: string) => PERMISSION_OPTIONS.find((o) => o.value === p)?.label ?? p;

export function useSharedWithMe() {
  const status = useSession((s) => s.status);
  return useQuery({
    queryKey: ["shared", "list"],
    enabled: status === "unlocked",
    queryFn: () => get<SharedWithMeItem[]>("/shared"),
    refetchInterval: 60_000,
  });
}

/** This user's own security code, for someone sharing with them to compare. */
function MySecurityCode() {
  const status = useSession((s) => s.status);
  const { data } = useQuery({
    queryKey: ["my-fingerprint", status],
    enabled: status === "unlocked",
    queryFn: async () => {
      try {
        return await publicKeyFingerprint(requireSharingKeys().publicKey);
      } catch {
        return null;
      }
    },
  });
  if (!data) return null;
  return (
    <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
      <ShieldCheck className="mt-px size-3.5 shrink-0" />
      <span>
        Your security code <span className="font-mono text-foreground">{data}</span>. Someone
        sharing with you sees the same code next to your name.
      </span>
    </p>
  );
}

function SharedRow({
  item,
  active,
  onOpen,
}: {
  item: SharedWithMeItem;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/60",
        active && "bg-accent",
      )}
    >
      <ItemGlyph type={item.type} className="size-9" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium text-sm">{item.name}</span>
          {item.isNew && item.status === "active" && (
            <Badge variant="info" size="sm">
              New
            </Badge>
          )}
          {item.status === "waiting" && (
            <Hourglass className="size-3 shrink-0 text-muted-foreground" aria-label="Waiting" />
          )}
        </span>
        <span className="flex items-center gap-1 truncate text-muted-foreground text-xs">
          <MemberAvatar name={item.sharedBy.name} className="size-4 text-[8px]" />
          {item.sharedBy.name}
          {item.subtitle ? ` · ${item.subtitle}` : ""}
        </span>
      </span>
    </button>
  );
}

function LeaveButton({ item, onLeft }: { item: SharedWithMeItem; onLeft: () => void }) {
  const qc = useQueryClient();
  const leave = useMutation({
    mutationFn: () => del(`/shared/${item.shareId}`),
    onSuccess: () => {
      toast.success(`Removed ${item.name}`, `${item.sharedBy.name} can share it again later.`);
      void qc.invalidateQueries({ queryKey: ["shared"] });
      onLeft();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}>
        <MoreHorizontal />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem variant="destructive" onClick={() => leave.mutate()}>
          <Trash2 /> Remove from Shared with me
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function SharedItemView({ summary, onClose }: { summary: SharedWithMeItem; onClose: () => void }) {
  const openEditor = useUi((s) => s.openEditor);
  const qc = useQueryClient();
  const waiting = summary.status === "waiting";
  const {
    data: item,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["shared", "item", summary.id, summary.revision],
    enabled: !waiting,
    staleTime: 0,
    queryFn: async () => {
      const detail = await loadSharedItem(summary.id);
      if (summary.isNew) void qc.invalidateQueries({ queryKey: ["shared", "list"] });
      return detail;
    },
  });
  const def = getItemType(summary.type);

  const header = (
    <div className="flex items-start gap-3">
      <ItemGlyph type={summary.type} className="size-11 rounded-xl [&_svg]:size-5" />
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-semibold text-xl">{summary.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
          <span>{def?.label ?? summary.type}</span>
          <Badge variant={summary.permission === "EDIT" ? "info" : "secondary"} size="sm">
            {permissionLabel(summary.permission)}
          </Badge>
          {summary.expiresAt && (
            <Badge variant="outline" size="sm">
              <Clock /> Until {shortDate(summary.expiresAt)}
            </Badge>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {summary.permission === "EDIT" && !waiting && item && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => openEditor({ itemId: summary.id, shared: true })}
          >
            <Pencil /> Edit
          </Button>
        )}
        <LeaveButton item={summary} onLeft={onClose} />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close"
          className="lg:hidden"
        >
          <X />
        </Button>
      </div>
    </div>
  );

  const sharedBy = (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
      <MemberAvatar name={summary.sharedBy.name} className="size-9" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="truncate">
          Shared by <span className="font-medium">{summary.sharedBy.name}</span>
        </div>
        <div className="truncate text-muted-foreground text-xs">
          {summary.sharedBy.email} · {timeAgo(summary.sharedAt)}
        </div>
      </div>
      <Users className="size-4 text-muted-foreground" />
    </div>
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-6">
      {header}
      {sharedBy}
      {waiting ? (
        <div className="flex gap-3 rounded-xl border border-dashed px-4 py-5 text-sm">
          <Hourglass className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium">Almost there</p>
            <p className="text-muted-foreground">
              {summary.sharedBy.name}'s Minions hands over the key the next time they open it. It's
              end-to-end encrypted, so nobody else, Minions included, can do that for them.
            </p>
          </div>
        </div>
      ) : isLoading ? (
        <Skeleton className="h-40" />
      ) : error || !item ? (
        <p className="text-muted-foreground text-sm">{errorMessage(error)}</p>
      ) : (
        <>
          {item.description && <p className="text-muted-foreground text-sm">{item.description}</p>}
          <Block title="Details">
            {item.fields.length === 0 && (
              <p className="px-4 py-3 text-muted-foreground text-xs">No fields.</p>
            )}
            {item.fields.map((f) => (
              <FieldRow
                key={f.key}
                itemId={item.id}
                type={item.type}
                field={f}
                cardLast4={item.cardLast4}
              />
            ))}
          </Block>
          <Block title="About">
            <div className="px-4 py-2">
              <Meta label="Last updated" value={timeAgo(item.updatedAt)} />
              {item.passwordUpdatedAt && (
                <Meta label="Secret last changed" value={shortDate(item.passwordUpdatedAt)} />
              )}
              <Meta label="Access" value={permissionLabel(item.permission)} />
              <Meta label="Expires" value={item.expiresAt ? shortDate(item.expiresAt) : "Never"} />
            </div>
          </Block>
        </>
      )}
    </div>
  );
}

function WithMe({ selected }: { selected?: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useSharedWithMe();
  const items = data ?? [];
  const current = items.find((i) => i.id === selected);
  const select = (item?: string) =>
    void navigate({ to: "/shared", search: (s: SharedSearch) => ({ ...s, item }) });

  return (
    <>
      <div
        className={cn(
          "relative flex w-full flex-col border-border border-r md:w-[24rem] md:shrink-0 lg:w-[26rem]",
          current && "hidden md:flex",
        )}
      >
        <div className="space-y-2 border-border border-b p-3">
          <p className="font-medium text-sm">Shared with me</p>
          <MySecurityCode />
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {isLoading && <Skeleton className="m-1 h-14" />}
          {!isLoading && items.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-muted-foreground text-sm">
              <Inbox className="size-8 opacity-50" />
              <p>Nothing shared with you yet.</p>
              <p className="text-xs">
                When someone shares a password with your email, it shows up here.
              </p>
            </div>
          )}
          {items.map((i) => (
            <SharedRow
              key={i.shareId}
              item={i}
              active={i.id === selected}
              onOpen={() => select(i.id)}
            />
          ))}
        </div>
      </div>
      <div className={cn("min-w-0 flex-1 overflow-y-auto", !current && "hidden md:block")}>
        {current ? (
          <SharedItemView key={current.id} summary={current} onClose={() => select(undefined)} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
            Select an item to see it.
          </div>
        )}
      </div>
    </>
  );
}

function ByMe() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["people", "all"],
    queryFn: () => get<PeopleShare[]>("/people-shares"),
  });
  const remove = useMutation({
    mutationFn: async (s: PeopleShare) => {
      const r = await del<{ rekeyNeeded: boolean }>(`/vault/items/${s.itemId}/people/${s.id}`);
      // They may have kept the key: replace it so nothing they hold opens the item any more.
      if (r?.rekeyNeeded) await setNewItemKey(s.itemId).catch(() => undefined);
      return r;
    },
    onSuccess: (r) => {
      toast.success(
        "Access removed",
        r?.rekeyNeeded
          ? "The item has a new key. They may have copied the password before, so consider changing it."
          : undefined,
      );
      void qc.invalidateQueries({ queryKey: ["people"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const groups = useMemo(() => {
    const m = new Map<string, PeopleShare[]>();
    for (const s of data ?? []) m.set(s.itemId, [...(m.get(s.itemId) ?? []), s]);
    return [...m.values()];
  }, [data]);

  return (
    <PageBody
      title="Shared by me"
      subtitle="Everything you've shared with people, and whether they have it yet."
    >
      {isLoading && <Skeleton className="h-32" />}
      {!isLoading && groups.length === 0 && (
        <EmptyNote>
          Nothing shared yet. Open an item in your vault and choose Share → People.
        </EmptyNote>
      )}
      {groups.map((shares) => {
        const first = shares[0]!;
        return (
          <section key={first.itemId} className="rounded-xl border bg-card">
            <Link
              to="/vault"
              search={{ item: first.itemId }}
              className="flex items-center gap-2.5 border-border/60 border-b px-4 py-2.5 hover:bg-accent/40"
            >
              <ItemGlyph type={first.itemType} className="size-7 [&_svg]:size-3.5" />
              <span className="flex-1 truncate font-medium text-sm">{first.itemName}</span>
              <span className="text-muted-foreground text-xs">
                {shares.length} {shares.length === 1 ? "person" : "people"}
              </span>
            </Link>
            {shares.map((s) => {
              const st = PEOPLE_STATUS[s.status];
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-2.5 border-border/60 border-b px-4 py-2 last:border-b-0"
                >
                  <MemberAvatar name={s.recipient?.name ?? s.email} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm">{s.recipient?.name ?? s.email}</span>
                      <Badge variant={st.variant} size="sm" title={st.hint || undefined}>
                        {st.label}
                      </Badge>
                    </div>
                    <div className="truncate text-muted-foreground text-xs">
                      {s.recipient ? `${s.email} · ` : ""}
                      {permissionLabel(s.permission)} ·{" "}
                      {s.expiresAt ? `until ${shortDate(s.expiresAt)}` : "no end date"}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => remove.mutate(s)}
                    aria-label={`Stop sharing with ${s.email}`}
                  >
                    <X /> Remove
                  </Button>
                </div>
              );
            })}
          </section>
        );
      })}
    </PageBody>
  );
}

export function SharedPage() {
  const search = useSearch({ strict: false }) as SharedSearch;
  const byMe = search.side === "by-me";
  return (
    <Page title={byMe ? "Shared by me" : "Shared with me"} fill={!byMe}>
      {byMe ? <ByMe /> : <WithMe selected={search.item} />}
    </Page>
  );
}
