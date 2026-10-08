import type { VaultItemSummary } from "@minions/core";
import {
  FolderKanban,
  GripVertical,
  Layers,
  MoreHorizontal,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ItemGlyph } from "@/lib/item-icons";
import { useDeleteItem, useToggleFavorite } from "@/lib/queries";
import { useSelection } from "@/lib/selection";
import { toast } from "@/lib/toast";
import { useDraggableItem, useMoveDialog } from "./organize";

/** A small coloured label for the project or collection an item sits in. */
export function GroupChip({
  name,
  color,
  icon: Icon,
}: {
  name: string;
  color?: string | null;
  icon: typeof Layers;
}) {
  return (
    <span className="inline-flex max-w-32 shrink-0 items-center gap-1 rounded-md border border-border/70 px-1.5 py-px text-[11px] text-muted-foreground">
      {color ? (
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
      ) : (
        <Icon className="size-3 shrink-0" />
      )}
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * What every item row shares, list or table: drag it, click to open, and
 * tick it (click while others are ticked, Cmd/Ctrl-click, Shift-click a range, or "x").
 */
export function useItemRow(item: VaultItemSummary, list: VaultItemSummary[], onOpen: () => void) {
  const selected = useSelection((s) => s.ids.has(item.id));
  const anySelected = useSelection((s) => s.ids.size > 0);
  const toggle = useSelection((s) => s.toggle);
  const extend = useSelection((s) => s.extend);
  const drag = useDraggableItem(item, list);

  const tick = (e: MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey)
      extend(
        item.id,
        list.map((i) => i.id),
      );
    else toggle(item.id);
  };

  const rowProps = {
    ...drag.attributes,
    ...drag.listeners,
    onClick: (e: MouseEvent) => {
      // While picking items, a click ticks instead of opening.
      if (e.metaKey || e.ctrlKey || e.shiftKey || anySelected) tick(e);
      else onOpen();
    },
    onKeyDown: (e: KeyboardEvent) => {
      // Space picks the row up for a keyboard drag (dnd-kit); Enter opens it.
      if (e.key === "Enter") onOpen();
      else if (e.key === "x") toggle(item.id);
      else drag.listeners?.onKeyDown?.(e);
    },
  };
  return { selected, anySelected, tick, drag, rowProps };
}

/** The ⋯ menu on a row: move, favourite, trash. */
export function ItemMenu({ item }: { item: VaultItemSummary }) {
  const openMove = useMoveDialog((s) => s.open);
  const favorite = useToggleFavorite();
  const remove = useDeleteItem();
  return (
    <Menu>
      <MenuTrigger
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 data-popup-open:opacity-100"
        aria-label={`Actions for ${item.name}`}
      >
        <MoreHorizontal className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end" onClick={(e) => e.stopPropagation()}>
        <MenuItem onClick={() => openMove("project", [item])}>
          <FolderKanban /> Move to project…
        </MenuItem>
        <MenuItem onClick={() => openMove("collection", [item])}>
          <Layers /> Move to collection…
        </MenuItem>
        <MenuItem onClick={() => favorite.mutate({ id: item.id, favorite: !item.favorite })}>
          <Star /> {item.favorite ? "Remove from favorites" : "Add to favorites"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          variant="destructive"
          onClick={() =>
            remove.mutate(item.id, {
              onSuccess: () => toast.success("Moved to trash"),
              onError: (e) => toast.error(errorMessage(e)),
            })
          }
        >
          <Trash2 /> Move to trash
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * One vault item in a list: tick it for bulk actions, drag it onto a project
 * or collection, or use its menu.
 */
export function ItemRow({
  item,
  list,
  active,
  onOpen,
  trash,
}: {
  item: VaultItemSummary;
  /** The whole visible list, for shift-click ranges and multi-item drags. */
  list: VaultItemSummary[];
  active: boolean;
  onOpen: () => void;
  trash?: boolean;
}) {
  const { selected, anySelected, tick, drag, rowProps } = useItemRow(item, list, onOpen);

  return (
    <div
      ref={drag.setNodeRef}
      {...rowProps}
      aria-current={active || undefined}
      className={cn(
        "group/row relative flex h-14 w-full cursor-default select-none items-center gap-2.5 rounded-lg px-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/40",
        active && "bg-accent hover:bg-accent",
        selected && "bg-primary/6 hover:bg-primary/10",
        drag.isDragging && "opacity-40",
      )}
    >
      <GripVertical
        aria-hidden
        className="-ml-1 size-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover/row:text-muted-foreground/50"
      />
      <span className="relative flex size-8 shrink-0 items-center justify-center">
        <span
          className={cn(
            "transition-opacity",
            (selected || anySelected) && "opacity-0",
            "group-hover/row:opacity-0",
          )}
        >
          <ItemGlyph type={item.type} />
        </span>
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover/row:opacity-100",
            (selected || anySelected) && "opacity-100",
          )}
        >
          <Checkbox
            checked={selected}
            onClick={tick}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Select ${item.name}`}
          />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium text-sm">{item.name}</span>
          {item.favorite && <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />}
          {!!item.sharedWith && (
            <Users
              className="size-3 shrink-0 text-info-foreground"
              aria-label={`Shared with ${item.sharedWith}`}
            />
          )}
          {item.environment === "Production" && (
            <span className="shrink-0 rounded bg-destructive/8 px-1 font-medium text-[10px] text-destructive-foreground">
              PROD
            </span>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <span className="truncate text-muted-foreground text-xs">{item.subtitle ?? " "}</span>
          {item.project && (
            <GroupChip name={item.project.name} color={item.project.color} icon={FolderKanban} />
          )}
          {item.collection && <GroupChip name={item.collection.name} color={null} icon={Layers} />}
        </span>
      </span>
      {!trash && <ItemMenu item={item} />}
    </div>
  );
}
