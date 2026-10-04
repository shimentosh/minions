import {
  aad,
  decryptString,
  getItemType,
  type ItemVersion,
  RELATION_LABELS,
  type RelationKind,
  resolveField,
  type VaultItemDetail,
  type VaultItemSummary,
} from "@minions/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArchiveRestore,
  Eye,
  History,
  KeyRound,
  Link2,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { del, errorMessage, get, post } from "@/lib/api";
import { copySecret } from "@/lib/clipboard";
import { ACTION_LABELS, shortDate, timeAgo } from "@/lib/format";
import { ItemGlyph } from "@/lib/item-icons";
import {
  useActivity,
  useDeleteItem,
  useInvalidateVault,
  useItem,
  useRestoreItem,
  useToggleFavorite,
} from "@/lib/queries";
import { requireVaultKey } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useUi } from "@/lib/ui-store";
import { revealField } from "@/lib/vault-crypto";
import { FieldRow } from "./field-row";
import { ItemPicker } from "./item-picker";
import { ShareItemDialog } from "./share-dialog";

export function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right">{value}</span>
    </div>
  );
}

export function Block({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-border/60 border-b px-4 py-2">
        <h3 className="font-semibold text-xs uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function VersionRow({ item, version }: { item: VaultItemDetail; version: ItemVersion }) {
  const [plain, setPlain] = useState<Record<string, string> | null>(null);
  async function reveal() {
    const out: Record<string, string> = {};
    for (const f of version.fields) {
      try {
        out[f.key] = f.sensitive
          ? await decryptString(requireVaultKey(), f.value, aad.version(item.id, f.key))
          : f.value;
      } catch {
        out[f.key] = "(could not decrypt)";
      }
    }
    setPlain(out);
  }
  return (
    <div className="border-border/60 border-b px-4 py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>
          Revision {version.revision} ·{" "}
          <span className="text-muted-foreground">{timeAgo(version.createdAt)}</span>
        </span>
        {plain ? (
          <Button variant="ghost" size="xs" onClick={() => setPlain(null)}>
            Hide
          </Button>
        ) : (
          <Button variant="ghost" size="xs" onClick={reveal}>
            <Eye /> Show previous values
          </Button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {version.changedKeys.map((k) => (
          <Badge key={k} variant="outline" size="sm">
            {resolveField(item.type, k, { label: k, sensitive: true })?.def.label ?? k}
          </Badge>
        ))}
      </div>
      {plain && (
        <dl className="mt-2 space-y-1 rounded-md bg-muted/50 p-2 text-xs">
          {Object.entries(plain).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">
                {resolveField(item.type, k, { label: k, sensitive: true })?.def.label ?? k}
              </dt>
              <dd className="secret-text min-w-0 whitespace-pre-wrap">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function HistoryBlock({ item }: { item: VaultItemDetail }) {
  const [open, setOpen] = useState(false);
  const versions = useQuery({
    queryKey: ["versions", item.id, item.revision],
    enabled: open,
    queryFn: () => get<ItemVersion[]>(`/vault/items/${item.id}/versions`),
  });
  return (
    <Block
      title={`History · ${item.versionCount} change${item.versionCount === 1 ? "" : "s"}`}
      action={
        item.versionCount > 0 && (
          <Button variant="ghost" size="xs" onClick={() => setOpen((o) => !o)}>
            <History /> {open ? "Hide" : "Show"}
          </Button>
        )
      }
    >
      {!open ? (
        <p className="px-4 py-3 text-muted-foreground text-xs">
          Previous values are kept encrypted and only shown when you ask.
        </p>
      ) : versions.isLoading ? (
        <Skeleton className="m-4 h-10" />
      ) : (
        versions.data?.map((v) => <VersionRow key={v.id} item={item} version={v} />)
      )}
    </Block>
  );
}

function RelationsBlock({ item }: { item: VaultItemDetail }) {
  const invalidate = useInvalidateVault();
  const [picking, setPicking] = useState(false);
  const [kind, setKind] = useState<RelationKind>("USED_FOR");
  const add = useMutation({
    mutationFn: (other: VaultItemSummary) =>
      post("/relations", { fromItemId: item.id, toItemId: other.id, kind }),
    onSuccess: () => {
      setPicking(false);
      void invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/relations/${id}`),
    onSuccess: () => void invalidate(),
  });

  return (
    <Block
      title="Relationships"
      action={
        <Button variant="ghost" size="xs" onClick={() => setPicking((p) => !p)}>
          <Link2 /> Link
        </Button>
      }
    >
      {picking && (
        <div className="space-y-2 border-border/60 border-b p-3">
          <div className="flex flex-wrap gap-1">
            {(Object.keys(RELATION_LABELS) as RelationKind[]).map((k) => (
              <Button
                key={k}
                size="xs"
                variant={kind === k ? "secondary" : "ghost"}
                onClick={() => setKind(k)}
              >
                {RELATION_LABELS[k].outgoing}
              </Button>
            ))}
          </div>
          <ItemPicker excludeId={item.id} onPick={(other) => add.mutate(other)} />
        </div>
      )}
      {item.relations.length === 0 && !picking && (
        <p className="px-4 py-3 text-muted-foreground text-xs">
          Link this to the services it signs in to, its 2FA or recovery codes. The credential stays
          in one place.
        </p>
      )}
      {item.relations.map((r) => (
        <div
          key={r.id}
          className="group flex items-center gap-2 border-border/60 border-b px-4 py-2 last:border-b-0"
        >
          <span className="w-24 shrink-0 text-muted-foreground text-xs">
            {RELATION_LABELS[r.kind]?.[r.direction] ?? r.kind}
          </span>
          <ItemGlyph type={r.item.type} className="size-6 [&_svg]:size-3.5" />
          <Link
            to="/vault"
            search={{ item: r.item.id }}
            className="min-w-0 flex-1 truncate text-sm hover:underline"
          >
            {r.item.name}
            {r.item.subtitle && (
              <span className="ml-1.5 text-muted-foreground text-xs">{r.item.subtitle}</span>
            )}
          </Link>
          {r.item.type === "LOGIN" && r.direction === "incoming" && (
            <LinkedLoginCopy loginId={r.item.id} />
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover:opacity-100 touch:opacity-100"
            onClick={() => remove.mutate(r.id)}
            aria-label="Remove link"
          >
            <X />
          </Button>
        </div>
      ))}
    </Block>
  );
}

/** Copy the linked login's username or password without leaving this item. */
function LinkedLoginCopy({ loginId }: { loginId: string }) {
  async function copy(keys: string[], label: string) {
    try {
      const login = await get<VaultItemDetail>(`/vault/items/${loginId}`);
      const field = keys.map((k) => login.fields.find((f) => f.key === k)).find(Boolean);
      if (!field) return toast.info(`${login.name} has no ${label.toLowerCase()}`);
      await copySecret(await revealField(login.id, field), {
        label,
        itemId: login.id,
        field: field.key,
        sensitive: field.sensitive,
      });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  return (
    <span className="flex shrink-0 gap-0.5">
      <Button
        variant="ghost"
        size="xs"
        onClick={() => void copy(["username", "email"], "Username")}
      >
        <User /> User
      </Button>
      <Button variant="ghost" size="xs" onClick={() => void copy(["password"], "Password")}>
        <KeyRound /> Password
      </Button>
    </span>
  );
}

function ItemActivity({ itemId }: { itemId: string }) {
  const { data } = useActivity({ itemId });
  const rows = data?.pages.flatMap((p) => p.items).slice(0, 8) ?? [];
  return (
    <Block title="Recent activity">
      {rows.length === 0 && <p className="px-4 py-3 text-muted-foreground text-xs">Nothing yet.</p>}
      {rows.map((a) => (
        <div
          key={a.id}
          className="flex items-center justify-between gap-2 border-border/60 border-b px-4 py-2 text-sm last:border-b-0"
        >
          <span>
            {ACTION_LABELS[a.action] ?? a.action}
            {typeof a.metadata?.field === "string" && (
              <span className="text-muted-foreground">
                {" "}
                ·{" "}
                {resolveField("LOGIN", a.metadata.field as string)?.def.label ??
                  (a.metadata.field as string)}
              </span>
            )}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {a.device ? `${a.device} · ` : ""}
            {timeAgo(a.createdAt)}
          </span>
        </div>
      ))}
    </Block>
  );
}

export function ItemDetail({ id, onClose }: { id: string; onClose?: () => void }) {
  const [sharing, setSharing] = useState(false);
  const { data: item, isLoading, error } = useItem(id);
  const openEditor = useUi((s) => s.openEditor);
  const favorite = useToggleFavorite();
  const remove = useDeleteItem();
  const restore = useRestoreItem();
  const invalidate = useInvalidateVault();
  const purge = useMutation({
    mutationFn: () => del(`/vault/items/${id}/purge`),
    onSuccess: () => {
      toast.success("Deleted permanently");
      onClose?.();
      void invalidate();
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (error || !item)
    return (
      <p className="p-6 text-muted-foreground text-sm">
        {error ? errorMessage(error) : "Not found"}
      </p>
    );

  const def = getItemType(item.type);
  const lifecycle =
    item.lastRotatedAt || item.expiresAt || item.status || def?.category === "secret";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-6">
      <div className="flex items-start gap-3">
        <ItemGlyph type={item.type} className="size-11 rounded-xl [&_svg]:size-5" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold text-xl">{item.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
            <span>{def?.label ?? item.type}</span>
            {item.environment && (
              <Badge
                variant={item.environment === "Production" ? "warning" : "secondary"}
                size="sm"
              >
                {item.environment}
              </Badge>
            )}
            {item.project && (
              <Link to="/projects/$projectId" params={{ projectId: item.project.id }}>
                <Badge variant="outline" size="sm">
                  {item.project.name}
                </Badge>
              </Link>
            )}
            {item.collection && (
              <Link to="/vault" search={{ collectionId: item.collection.id }}>
                <Badge variant="outline" size="sm">
                  {item.collection.name}
                </Badge>
              </Link>
            )}
            {item.tags.map((t) => (
              <Link key={t} to="/vault" search={{ tag: t }}>
                <Badge variant="secondary" size="sm">
                  #{t}
                </Badge>
              </Link>
            ))}
            {item.deletedAt && (
              <Badge variant="error" size="sm">
                In trash
              </Badge>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => favorite.mutate({ id: item.id, favorite: !item.favorite })}
            aria-label={item.favorite ? "Remove from favorites" : "Add to favorites"}
          >
            <Star className={item.favorite ? "fill-amber-400 text-amber-400" : ""} />
          </Button>
          {!item.deletedAt && (
            <Button variant="outline" size="sm" onClick={() => setSharing(true)}>
              <Link2 /> Share
            </Button>
          )}
          {!item.deletedAt && (
            <Button variant="outline" size="sm" onClick={() => openEditor({ itemId: item.id })}>
              <Pencil /> Edit
            </Button>
          )}
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuPopup align="end">
              {item.deletedAt ? (
                <>
                  <MenuItem onClick={() => restore.mutate(item.id)}>
                    <ArchiveRestore /> Restore
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={() => purge.mutate()}>
                    <Trash2 /> Delete permanently
                  </MenuItem>
                </>
              ) : (
                <MenuItem
                  variant="destructive"
                  onClick={() =>
                    remove.mutate(item.id, {
                      onSuccess: () => {
                        toast.success("Moved to trash");
                        onClose?.();
                      },
                    })
                  }
                >
                  <Trash2 /> Move to trash
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close"
              className="lg:hidden"
            >
              <X />
            </Button>
          )}
        </div>
      </div>

      {sharing && <ShareItemDialog item={item} open={sharing} onOpenChange={setSharing} />}
      {item.description && <p className="text-muted-foreground text-sm">{item.description}</p>}

      <Block title="Details">
        {item.fields.length === 0 && (
          <p className="px-4 py-3 text-muted-foreground text-xs">No fields yet.</p>
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

      {item.usedBy.length > 0 && (
        <Block title="Used by">
          <div className="flex flex-wrap gap-1.5 p-3">
            {item.usedBy.map((p) => (
              <Link key={p.id} to="/projects/$projectId" params={{ projectId: p.id }}>
                <Badge variant="outline">{p.name}</Badge>
              </Link>
            ))}
          </div>
        </Block>
      )}

      <RelationsBlock item={item} />

      <Block title="Lifecycle">
        <div className="px-4 py-2">
          {lifecycle && item.status && <Meta label="Status" value={item.status} />}
          <Meta label="Created" value={shortDate(item.createdAt)} />
          <Meta label="Last updated" value={timeAgo(item.updatedAt)} />
          {item.passwordUpdatedAt && (
            <Meta label="Secret last changed" value={shortDate(item.passwordUpdatedAt)} />
          )}
          {item.lastRotatedAt && (
            <Meta label="Last rotated" value={shortDate(item.lastRotatedAt)} />
          )}
          {item.expiresAt && (
            <Meta
              label="Expires"
              value={
                <span
                  className={
                    new Date(item.expiresAt) < new Date() ? "text-destructive-foreground" : ""
                  }
                >
                  {shortDate(item.expiresAt)}
                </span>
              }
            />
          )}
          <Meta label="Last used" value={timeAgo(item.lastAccessedAt)} />
          <Meta label="Times used" value={item.accessCount} />
        </div>
      </Block>

      <HistoryBlock item={item} />
      <ItemActivity itemId={item.id} />
    </div>
  );
}
