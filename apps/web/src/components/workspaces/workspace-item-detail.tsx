import { getItemType, resolveField, type WorkspaceItemDetail } from "@minions/core";
import { useMutation } from "@tanstack/react-query";
import {
  ArchiveRestore,
  ExternalLink,
  Globe,
  Lock,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  ShieldAlert,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { FieldRow } from "@/components/vault/field-row";
import { Block, Meta } from "@/components/vault/item-detail";
import { del, errorMessage, patch, post } from "@/lib/api";
import { ACTION_LABELS, shortDate, timeAgo } from "@/lib/format";
import { ItemGlyph } from "@/lib/item-icons";
import { toast } from "@/lib/toast";
import { useUi } from "@/lib/ui-store";
import { rekeyItem } from "@/lib/workspace-crypto";
import {
  useInvalidateWorkspaces,
  useItemAccess,
  useWorkspaceItem,
  useWorkspaceItemActivity,
} from "@/lib/workspace-queries";
import { AccessDialog } from "./access-dialog";
import { MemberAvatar } from "./member-avatar";

export function accessLabel(item: { workspaceShared: boolean; grantCount: number }) {
  if (item.workspaceShared) return { icon: Globe, label: "Everyone" };
  if (item.grantCount <= 1) return { icon: Lock, label: "Private" };
  return { icon: Users, label: `${item.grantCount} people` };
}

function siteUrl(item: WorkspaceItemDetail) {
  const url = item.fields.find((f) => f.key === "url" && !f.sensitive)?.value;
  if (!url) return null;
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function AccessBlock({ item, onManage }: { item: WorkspaceItemDetail; onManage: () => void }) {
  const { data } = useItemAccess(item.workspaceId, item.id);
  return (
    <Block
      title="Access"
      action={
        item.permission === "MANAGE" && (
          <Button variant="ghost" size="xs" onClick={onManage}>
            <Users /> Manage access
          </Button>
        )
      }
    >
      {data?.workspaceShared && (
        <div className="flex items-center gap-2 border-border/60 border-b px-4 py-2 text-sm">
          <Globe className="size-4 text-muted-foreground" />
          Everyone confirmed in the workspace can use it
        </div>
      )}
      {data?.grants.map((g) => (
        <div
          key={g.userId}
          className="flex items-center gap-2 border-border/60 border-b px-4 py-2 last:border-b-0"
        >
          <MemberAvatar name={g.name || g.email} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">
              {g.name}
              {item.createdBy?.id === g.userId && (
                <span className="text-muted-foreground text-xs"> · owner</span>
              )}
            </div>
            <div className="truncate text-muted-foreground text-xs">{g.email}</div>
          </div>
          <Badge variant={g.permission === "MANAGE" ? "secondary" : "outline"} size="sm">
            {g.permission === "MANAGE" ? "Can manage" : "Can use"}
          </Badge>
        </div>
      ))}
    </Block>
  );
}

function ActivityBlock({ item }: { item: WorkspaceItemDetail }) {
  const { data } = useWorkspaceItemActivity(
    item.workspaceId,
    item.id,
    item.permission === "MANAGE",
  );
  if (item.permission !== "MANAGE") return null;
  const rows = data?.items.slice(0, 10) ?? [];
  return (
    <Block title="Who used it">
      {rows.length === 0 && <p className="px-4 py-3 text-muted-foreground text-xs">Nothing yet.</p>}
      {rows.map((a) => (
        <div
          key={a.id}
          className="flex items-center justify-between gap-2 border-border/60 border-b px-4 py-2 text-sm last:border-b-0"
        >
          <span className="min-w-0 truncate">
            <span className="font-medium">{a.actor?.name ?? "Someone"}</span>{" "}
            <span className="text-muted-foreground">
              {(ACTION_LABELS[a.action] ?? a.action).toLowerCase()}
              {typeof a.metadata?.field === "string" &&
                ` · ${resolveField(item.type, a.metadata.field as string)?.def.label ?? a.metadata.field}`}
              {typeof a.metadata?.member === "string" && ` · ${a.metadata.member}`}
            </span>
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

export function WorkspaceItemDetailView({
  workspaceId,
  id,
  onClose,
}: {
  workspaceId: string;
  id: string;
  onClose?: () => void;
}) {
  const { data: item, isLoading, error } = useWorkspaceItem(workspaceId, id);
  const { data: access } = useItemAccess(workspaceId, id, !!item?.rekeyNeeded);
  const openEditor = useUi((s) => s.openEditor);
  const invalidate = useInvalidateWorkspaces();
  const [managing, setManaging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const base = `/workspaces/${workspaceId}/items/${id}`;

  const act = (fn: () => Promise<unknown>, done: string, after?: () => void) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(done);
      after?.();
      void invalidate();
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const favorite = useMutation(
    act(
      () => patch(base, { favorite: !item?.favorite }),
      item?.favorite ? "Removed from favorites" : "Added to favorites",
    ),
  );
  const trash = useMutation(act(() => del(base), "Moved to trash", onClose));
  const restore = useMutation(act(() => post(`${base}/restore`), "Restored"));
  const purge = useMutation(act(() => del(`${base}/purge`), "Deleted permanently", onClose));
  const rekey = useMutation(
    act(async () => {
      if (!item || !access) throw new Error("Still loading access");
      await rekeyItem(item, access);
    }, "Key rotated"),
  );

  if (isLoading)
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-40" />
      </div>
    );
  if (error || !item)
    return (
      <p className="p-6 text-muted-foreground text-sm">
        {error ? errorMessage(error) : "Credential not found"}
      </p>
    );

  const def = getItemType(item.type);
  const manage = item.permission === "MANAGE";
  const url = siteUrl(item);
  const a = accessLabel(item);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-6">
      <div className="flex items-start gap-3">
        <ItemGlyph type={item.type} className="size-11 rounded-xl [&_svg]:size-5" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold text-xl">{item.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
            <span>{item.host ?? def?.label ?? item.type}</span>
            <Badge variant="outline" size="sm">
              <a.icon className="size-3" /> {a.label}
            </Badge>
            {!manage && (
              <Badge variant="secondary" size="sm">
                Can use
              </Badge>
            )}
            {item.collection && (
              <Badge variant="outline" size="sm">
                {item.collection.name}
              </Badge>
            )}
            {item.tags.map((t) => (
              <Badge key={t} variant="secondary" size="sm">
                #{t}
              </Badge>
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
            onClick={() => favorite.mutate()}
            aria-label={item.favorite ? "Remove from favorites" : "Add to favorites"}
          >
            <Star className={item.favorite ? "fill-amber-400 text-amber-400" : ""} />
          </Button>
          {url && (
            <Button
              variant="outline"
              size="sm"
              render={<a href={url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLink /> Open
            </Button>
          )}
          {manage && !item.deletedAt && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openEditor({ itemId: item.id, workspaceId })}
            >
              <Pencil /> Edit
            </Button>
          )}
          {manage && (
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
              >
                <MoreHorizontal />
              </MenuTrigger>
              <MenuPopup align="end">
                {item.deletedAt ? (
                  <>
                    <MenuItem onClick={() => restore.mutate()}>
                      <ArchiveRestore /> Restore
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                      <Trash2 /> Delete permanently
                    </MenuItem>
                  </>
                ) : (
                  <>
                    <MenuItem onClick={() => setManaging(true)}>
                      <Users /> Manage access
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                      <Trash2 /> Move to trash
                    </MenuItem>
                  </>
                )}
              </MenuPopup>
            </Menu>
          )}
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

      {item.rekeyNeeded && manage && !item.deletedAt && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning/8 p-3 text-sm">
          <ShieldAlert className="size-4 shrink-0 text-warning-foreground" />
          <p className="min-w-0 flex-1">
            Someone who could open this credential lost access. Change the password at the service,
            then rotate the key so their copy of the old key opens nothing.
          </p>
          <Button
            size="sm"
            variant="outline"
            loading={rekey.isPending}
            onClick={() => rekey.mutate()}
          >
            <RefreshCw /> Rotate key
          </Button>
        </div>
      )}

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

      <AccessBlock item={item} onManage={() => setManaging(true)} />

      <Block title="Lifecycle">
        <div className="px-4 py-2">
          <Meta label="Created by" value={item.createdBy?.name ?? "—"} />
          <Meta label="Created" value={shortDate(item.createdAt)} />
          <Meta label="Last updated" value={timeAgo(item.updatedAt)} />
          {item.passwordUpdatedAt && (
            <Meta label="Password last changed" value={shortDate(item.passwordUpdatedAt)} />
          )}
          <Meta label="Last used" value={timeAgo(item.lastAccessedAt)} />
          <Meta label="Times used" value={item.accessCount} />
        </div>
      </Block>

      <ActivityBlock item={item} />

      {managing && <AccessDialog item={item} open={managing} onOpenChange={setManaging} />}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {item.deletedAt
                ? `Delete ${item.name} permanently?`
                : `Move ${item.name} to the trash?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {item.deletedAt
                ? "It is erased for everyone in the workspace. This cannot be undone."
                : "Nobody without manage access can use it from now on. Managers can restore it from the trash."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              loading={trash.isPending || purge.isPending}
              onClick={() => {
                setConfirmDelete(false);
                if (item.deletedAt) purge.mutate();
                else trash.mutate();
              }}
            >
              {item.deletedAt ? "Delete permanently" : "Move to trash"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
