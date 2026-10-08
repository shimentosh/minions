import { getItemType, type VaultItemSummary } from "@minions/core";
import { ArrowDown, FolderKanban, Layers, Star, Users } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { ItemGlyph } from "@/lib/item-icons";
import type { ItemFilters } from "@/lib/queries";
import { useSelection } from "@/lib/selection";
import { GroupChip, ItemMenu, useItemRow } from "./item-row";

type Sort = NonNullable<ItemFilters["sort"]>;

function Row({
  item,
  list,
  active,
  onOpen,
  trash,
  compact,
}: {
  item: VaultItemSummary;
  list: VaultItemSummary[];
  active: boolean;
  onOpen: () => void;
  trash?: boolean;
  /** Fewer columns, for when the details panel takes half the width. */
  compact?: boolean;
}) {
  const { selected, tick, drag, rowProps } = useItemRow(item, list, onOpen);
  return (
    <tr
      ref={drag.setNodeRef}
      {...rowProps}
      aria-current={active || undefined}
      className={cn(
        "group/row h-12 cursor-default select-none border-border/60 border-b outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50",
        active && "bg-accent hover:bg-accent",
        selected && "bg-primary/6 hover:bg-primary/10",
        drag.isDragging && "opacity-40",
      )}
    >
      <td className="w-10 pl-3">
        <Checkbox
          checked={selected}
          onClick={tick}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={`Select ${item.name}`}
        />
      </td>
      <td className="max-w-0 py-1.5 pr-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <ItemGlyph type={item.type} className="size-7 [&_svg]:size-3.5" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
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
            </div>
            {item.subtitle && (
              <div className="truncate text-muted-foreground text-xs">{item.subtitle}</div>
            )}
          </div>
        </div>
      </td>
      <td
        className={cn(
          "hidden whitespace-nowrap pr-3 text-muted-foreground text-xs",
          !compact && "md:table-cell",
        )}
      >
        {getItemType(item.type)?.label ?? item.type}
      </td>
      <td className="hidden pr-3 lg:table-cell">
        {item.project ? (
          <GroupChip name={item.project.name} color={item.project.color} icon={FolderKanban} />
        ) : (
          <span className="text-muted-foreground/50 text-xs">—</span>
        )}
      </td>
      <td className={cn("hidden pr-3", !compact && "lg:table-cell")}>
        {item.collection ? (
          <GroupChip name={item.collection.name} color={null} icon={Layers} />
        ) : (
          <span className="text-muted-foreground/50 text-xs">—</span>
        )}
      </td>
      <td className={cn("hidden max-w-40 pr-3", !compact && "xl:table-cell")}>
        <div className="flex gap-1 overflow-hidden">
          {item.tags.slice(0, 3).map((t) => (
            <span key={t} className="shrink-0 text-muted-foreground text-xs">
              #{t}
            </span>
          ))}
        </div>
      </td>
      <td className="hidden whitespace-nowrap pr-3 text-muted-foreground text-xs tabular-nums sm:table-cell">
        {timeAgo(item.updatedAt)}
      </td>
      <td className="w-10 pr-2">{!trash && <ItemMenu item={item} />}</td>
    </tr>
  );
}

/** The vault as a table: one row per item, sortable by name or date. */
export function ItemTable({
  items,
  activeId,
  onOpen,
  sort,
  onSort,
  trash,
  compact,
}: {
  items: VaultItemSummary[];
  activeId?: string;
  onOpen: (id: string) => void;
  sort: Sort;
  onSort: (sort: Sort) => void;
  trash?: boolean;
  /** Fewer columns, for when the details panel takes half the width. */
  compact?: boolean;
}) {
  const ids = useSelection((s) => s.ids);
  const set = useSelection((s) => s.set);
  const clear = useSelection((s) => s.clear);
  const all = items.length > 0 && items.every((i) => ids.has(i.id));
  const some = !all && items.some((i) => ids.has(i.id));

  const head = (label: string, key?: Sort, className?: string) => (
    <th
      className={cn(
        "h-9 whitespace-nowrap pr-3 text-left font-medium text-muted-foreground text-xs",
        className,
      )}
    >
      {key ? (
        <button
          type="button"
          onClick={() => onSort(key)}
          className={cn(
            "inline-flex items-center gap-1 hover:text-foreground",
            sort === key && "text-foreground",
          )}
        >
          {label}
          {sort === key && <ArrowDown className="size-3" />}
        </button>
      ) : (
        label
      )}
    </th>
  );

  return (
    <table className="w-full table-fixed text-sm">
      <colgroup>
        <col className="w-10" />
        <col />
        <col className={cn("hidden w-32", !compact && "md:table-column")} />
        <col className="hidden w-44 lg:table-column" />
        <col className={cn("hidden w-36", !compact && "lg:table-column")} />
        <col className={cn("hidden w-40", !compact && "xl:table-column")} />
        <col className="hidden w-28 sm:table-column" />
        <col className="w-10" />
      </colgroup>
      <thead className="sticky top-0 z-10 bg-card">
        <tr className="border-border border-b">
          <th className="w-10 pl-3">
            <Checkbox
              checked={all}
              indeterminate={some}
              onCheckedChange={() => (all ? clear() : set(items.map((i) => i.id)))}
              aria-label="Select all"
            />
          </th>
          {head("Name", "name")}
          {head("Type", undefined, compact ? "hidden" : "hidden md:table-cell")}
          {head("Project", undefined, "hidden lg:table-cell")}
          {head("Collection", undefined, compact ? "hidden" : "hidden lg:table-cell")}
          {head("Tags", undefined, compact ? "hidden" : "hidden xl:table-cell")}
          {head("Updated", "updated", "hidden sm:table-cell")}
          <th className="w-10" />
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <Row
            key={item.id}
            item={item}
            list={items}
            active={item.id === activeId}
            onOpen={() => onOpen(item.id)}
            trash={trash}
            compact={compact}
          />
        ))}
      </tbody>
    </table>
  );
}
