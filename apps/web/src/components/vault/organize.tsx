import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { VaultItemSummary } from "@minions/core";
import { Check, FolderKanban, Layers, Plus, SearchIcon, Star, Tag, Trash2, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { create } from "zustand";
import { NewGroupDialog } from "@/components/layout/new-group-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { ItemGlyph } from "@/lib/item-icons";
import { useCollections, useDeleteItem, usePatchItems, useProjects } from "@/lib/queries";
import { useSelection } from "@/lib/selection";
import { toast, toastWithAction } from "@/lib/toast";

export type GroupKind = "project" | "collection";

/** Where items can be dropped or moved: a project, a collection, or out of one (`id: null`). */
export interface MoveTarget {
  kind: GroupKind;
  id: string | null;
  name: string;
}

const field = (kind: GroupKind) => (kind === "project" ? "projectId" : "collectionId");
const current = (item: VaultItemSummary, kind: GroupKind) =>
  (kind === "project" ? item.project?.id : item.collection?.id) ?? null;

/** Moves items, then offers Undo, which puts each item back where it was. */
export function useMoveItems() {
  const patch = usePatchItems();
  const clear = useSelection((s) => s.clear);
  return (items: VaultItemSummary[], target: MoveTarget) => {
    const moving = items.filter((i) => current(i, target.kind) !== target.id);
    if (!moving.length) {
      toast.info(`Already in ${target.name}`);
      return;
    }
    // Group by where each item came from, so Undo is one request per origin.
    const origins = new Map<string | null, string[]>();
    for (const i of moving) {
      const from = current(i, target.kind);
      origins.set(from, [...(origins.get(from) ?? []), i.id]);
    }
    patch.mutate(
      { ids: moving.map((i) => i.id), [field(target.kind)]: target.id },
      {
        onSuccess: () => {
          clear();
          const what = moving.length === 1 ? `"${moving[0]!.name}"` : `${moving.length} items`;
          toastWithAction(
            target.id ? `Moved ${what} to ${target.name}` : `Removed ${what} from ${target.name}`,
            "Undo",
            () => {
              for (const [from, ids] of origins) patch.mutate({ ids, [field(target.kind)]: from });
            },
          );
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Drag and drop

interface DragData {
  items: VaultItemSummary[];
}

/**
 * Makes a list row draggable. Dragging a ticked row drags every ticked row of
 * `list`; dragging any other row drags just that one.
 */
export function useDraggableItem(item: VaultItemSummary, list: VaultItemSummary[]) {
  const selected = useSelection((s) => s.ids);
  const items = selected.has(item.id) ? list.filter((i) => selected.has(i.id)) : [item];
  return useDraggable({ id: `item:${item.id}`, data: { items } satisfies DragData });
}

/** A project or collection that accepts dropped items. */
export function useDropTarget(target: MoveTarget) {
  const drop = useDroppable({
    id: `${target.kind}:${target.id ?? "none"}`,
    data: { target },
  });
  return { ...drop, dragging: !!drop.active };
}

/** Wraps the app: lets rows be dragged onto projects and collections anywhere. */
export function OrganizeDnd({ children }: { children: ReactNode }) {
  const move = useMoveItems();
  const [dragged, setDragged] = useState<VaultItemSummary[] | null>(null);
  // A small distance keeps clicks on rows working as clicks.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const onStart = (e: DragStartEvent) =>
    setDragged((e.active.data.current as DragData | undefined)?.items ?? null);
  const onEnd = (e: DragEndEvent) => {
    setDragged(null);
    const items = (e.active.data.current as DragData | undefined)?.items;
    const target = (e.over?.data.current as { target?: MoveTarget } | undefined)?.target;
    if (items?.length && target) move(items, target);
  };
  return (
    <DndContext
      sensors={sensors}
      onDragStart={onStart}
      onDragEnd={onEnd}
      onDragCancel={() => setDragged(null)}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {dragged?.length ? (
          <div className="flex w-64 items-center gap-2.5 rounded-lg border border-border bg-popover px-2.5 py-2 shadow-lg">
            <ItemGlyph type={dragged[0]!.type} />
            <span className="min-w-0 flex-1 truncate font-medium text-sm">
              {dragged.length === 1 ? dragged[0]!.name : `${dragged.length} items`}
            </span>
            {dragged.length > 1 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 font-medium text-[11px] text-primary-foreground">
                {dragged.length}
              </span>
            )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// ---------------------------------------------------------------------------
// Move to… dialog, opened from the bulk bar, row menus and item detail

interface MoveDialogState {
  request: { kind: GroupKind; items: VaultItemSummary[] } | null;
  open: (kind: GroupKind, items: VaultItemSummary[]) => void;
  close: () => void;
}

export const useMoveDialog = create<MoveDialogState>((set) => ({
  request: null,
  open: (kind, items) => set({ request: { kind, items } }),
  close: () => set({ request: null }),
}));

export function MoveDialog() {
  const request = useMoveDialog((s) => s.request);
  const close = useMoveDialog((s) => s.close);
  const move = useMoveItems();
  const { data: projects } = useProjects();
  const { data: collections } = useCollections();
  const [q, setQ] = useState("");
  if (!request) return null;

  const { kind, items } = request;
  const label = kind === "project" ? "project" : "collection";
  const groups =
    kind === "project" ? (projects ?? []).filter((p) => !p.archived) : (collections ?? []);
  const shown = groups.filter((g) => g.name.toLowerCase().includes(q.trim().toLowerCase()));
  // Mark the group every moved item already shares.
  const shared = new Set(items.map((i) => current(i, kind)));
  const here = shared.size === 1 ? [...shared][0] : undefined;

  const pick = (target: MoveTarget) => {
    move(items, target);
    setQ("");
    close();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          setQ("");
          close();
        }
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Move {items.length === 1 ? `"${items[0]!.name}"` : `${items.length} items`} to a {label}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="relative">
            <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 text-muted-foreground/70" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Find a ${label}…`}
              className="ps-8"
              size="sm"
            />
          </div>
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {shown.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => pick({ kind, id: g.id, name: g.name })}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent"
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: g.color ?? "var(--muted-foreground)" }}
                />
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                <span className="text-muted-foreground text-xs">{g.itemCount}</span>
                {here === g.id && <Check className="size-4 text-muted-foreground" />}
              </button>
            ))}
            {!shown.length && (
              <p className="py-6 text-center text-muted-foreground text-sm">
                {groups.length ? "No match." : `No ${label}s yet.`}
              </p>
            )}
            {here && (
              <button
                type="button"
                onClick={() => pick({ kind, id: null, name: `its ${label}` })}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" /> Remove from {label}
              </button>
            )}
          </div>
        </DialogPanel>
        <DialogFooter className="justify-between sm:justify-between">
          <NewGroupDialog
            kind={kind}
            onCreated={(id, name) => pick({ kind, id, name })}
            trigger={
              <Button variant="outline">
                <Plus /> New {label}
              </Button>
            }
          />
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Bulk action bar

/** Floats over the list while items are ticked. */
export function BulkBar({ items, trash }: { items: VaultItemSummary[]; trash?: boolean }) {
  const ids = useSelection((s) => s.ids);
  const clear = useSelection((s) => s.clear);
  const openMove = useMoveDialog((s) => s.open);
  const patch = usePatchItems();
  const remove = useDeleteItem();
  const [tagging, setTagging] = useState(false);
  const [tag, setTag] = useState("");
  const selected = items.filter((i) => ids.has(i.id));
  if (!selected.length) return null;

  const allFavorite = selected.every((i) => i.favorite);
  const done = (msg: string) => {
    toast.success(msg);
    clear();
  };
  const fail = (e: unknown) => toast.error(errorMessage(e));
  const n = selected.length;
  const what = `${n} item${n === 1 ? "" : "s"}`;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3">
      <div
        role="toolbar"
        aria-label="Bulk actions"
        className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg"
      >
        <span className="px-2 font-medium text-sm tabular-nums">{n} selected</span>
        <span className="h-5 w-px shrink-0 bg-border" />
        {trash ? null : tagging ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const t = tag.trim().toLowerCase();
              if (!t) return;
              patch.mutate(
                { ids: selected.map((i) => i.id), addTags: [t] },
                {
                  onSuccess: () => {
                    setTagging(false);
                    setTag("");
                    done(`Tagged ${what} #${t}`);
                  },
                  onError: fail,
                },
              );
            }}
          >
            <Input
              autoFocus
              size="sm"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="tag name"
              className="w-32"
              maxLength={40}
              onKeyDown={(e) => e.key === "Escape" && setTagging(false)}
            />
            <Button size="sm" type="submit" loading={patch.isPending}>
              Add
            </Button>
          </form>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => openMove("project", selected)}>
              <FolderKanban /> Project
            </Button>
            <Button size="sm" variant="ghost" onClick={() => openMove("collection", selected)}>
              <Layers /> Collection
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setTagging(true)}>
              <Tag /> Tag
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                patch.mutate(
                  { ids: selected.map((i) => i.id), favorite: !allFavorite },
                  {
                    onSuccess: () =>
                      done(allFavorite ? "Removed from favorites" : "Added to favorites"),
                    onError: fail,
                  },
                )
              }
            >
              <Star className={allFavorite ? "fill-amber-400 text-amber-400" : ""} />
              {allFavorite ? "Unfavorite" : "Favorite"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive-foreground"
              onClick={() =>
                void Promise.all(selected.map((i) => remove.mutateAsync(i.id)))
                  .then(() => done(`Moved ${what} to trash`))
                  .catch(fail)
              }
            >
              <Trash2 /> Trash
            </Button>
          </>
        )}
        <span className="h-5 w-px shrink-0 bg-border" />
        <Button size="icon-sm" variant="ghost" onClick={clear} aria-label="Clear selection">
          <X />
        </Button>
      </div>
    </div>
  );
}
