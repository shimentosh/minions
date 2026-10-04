import type { Page, VaultItemSummary } from "@minions/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { get } from "@/lib/api";
import { ItemGlyph } from "@/lib/item-icons";

/** Search-as-you-type over the vault's safe metadata, to pick one item. */
export function ItemPicker({
  onPick,
  excludeId,
  placeholder = "Search items to link…",
  initialQuery = "",
  types,
}: {
  onPick: (item: VaultItemSummary) => void;
  excludeId?: string;
  placeholder?: string;
  initialQuery?: string;
  /** Comma-separated item types to search, e.g. "LOGIN". */
  types?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const { data } = useQuery({
    queryKey: ["item-picker", q, types],
    queryFn: () =>
      get<Page<VaultItemSummary>>("/vault/items", {
        q,
        types,
        limit: 8,
        sort: q ? "updated" : "recent",
      }),
    placeholderData: (prev) => prev,
  });
  const items = (data?.items ?? []).filter((i) => i.id !== excludeId);
  return (
    <div className="space-y-1">
      <Input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        size="sm"
      />
      <div className="max-h-56 overflow-y-auto">
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => onPick(i)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            <ItemGlyph type={i.type} className="size-6 [&_svg]:size-3.5" />
            <span className="min-w-0 flex-1 truncate">{i.name}</span>
            <span className="truncate text-muted-foreground text-xs">{i.subtitle}</span>
          </button>
        ))}
        {items.length === 0 && (
          <p className="px-2 py-2 text-muted-foreground text-xs">No matches</p>
        )}
      </div>
    </div>
  );
}
