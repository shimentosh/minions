import { CATEGORY_LABELS, type ItemCategory, type VaultItemSummary } from "@minions/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { KeyRound, Plus, SearchIcon, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Page } from "@/components/layout/page";
import { SimpleSelect } from "@/components/simple-select";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ItemDetail } from "@/components/vault/item-detail";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { ItemGlyph } from "@/lib/item-icons";
import { type ItemFilters, useCollections, useItems, useProjects } from "@/lib/queries";
import { useUi } from "@/lib/ui-store";

export interface VaultSearch {
  q?: string;
  category?: ItemCategory;
  projectId?: string;
  collectionId?: string;
  tag?: string;
  favorite?: boolean;
  trash?: boolean;
  sort?: ItemFilters["sort"];
  item?: string;
}

function ItemRow({
  item,
  active,
  onSelect,
}: {
  item: VaultItemSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/60",
        active && "bg-accent hover:bg-accent",
      )}
    >
      <ItemGlyph type={item.type} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium text-sm">{item.name}</span>
          {item.favorite && <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />}
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          {item.subtitle ?? item.project?.name ?? " "}
        </span>
      </span>
      <span className="hidden shrink-0 text-[11px] text-muted-foreground/80 sm:block">
        {item.environment === "Production" ? "Prod" : ""}
      </span>
    </button>
  );
}

export function VaultPage() {
  const search = useSearch({ strict: false }) as VaultSearch;
  const navigate = useNavigate();
  const openEditor = useUi((s) => s.openEditor);
  const { data: projects } = useProjects();
  const { data: collections } = useCollections();
  const [q, setQ] = useState(search.q ?? "");
  const listRef = useRef<HTMLDivElement>(null);

  // Debounced: the server searches safe metadata only.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((search.q ?? "") !== q)
        void navigate({
          to: "/vault",
          search: (s: VaultSearch) => ({ ...s, q: q || undefined }),
          replace: true,
        });
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, search.q, navigate]);

  const filters: ItemFilters = {
    q: search.q,
    category: search.category,
    projectId: search.projectId,
    collectionId: search.collectionId,
    tag: search.tag,
    favorite: search.favorite,
    trash: search.trash,
    sort: search.sort,
  };
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useItems(filters);
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const total = data?.pages[0]?.total;

  const title = search.trash
    ? "Trash"
    : search.favorite
      ? "Favorites"
      : search.category
        ? CATEGORY_LABELS[search.category]
        : search.collectionId
          ? (collections?.find((c) => c.id === search.collectionId)?.name ?? "Collection")
          : search.projectId
            ? (projects?.find((p) => p.id === search.projectId)?.name ?? "Project")
            : search.tag
              ? `#${search.tag}`
              : "All items";

  const select = (id: string | undefined) =>
    void navigate({ to: "/vault", search: (s: VaultSearch) => ({ ...s, item: id }) });

  // Infinite scroll for large vaults: fetch the next page near the bottom.
  const onScroll = () => {
    const el = listRef.current;
    if (
      el &&
      hasNextPage &&
      !isFetchingNextPage &&
      el.scrollTop + el.clientHeight > el.scrollHeight - 400
    )
      void fetchNextPage();
  };

  return (
    <Page title={title} crumbs={search.item ? [] : []} fill>
      <div
        className={cn(
          "flex w-full flex-col border-border border-r md:w-[22rem] md:shrink-0 lg:w-96",
          search.item && "hidden md:flex",
        )}
      >
        <div className="space-y-2 border-border border-b p-3">
          <div className="relative">
            <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 text-muted-foreground/70" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}…`}
              className="ps-8"
              size="sm"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              {total !== undefined ? `${total} item${total === 1 ? "" : "s"}` : " "}
            </span>
            <SimpleSelect
              size="sm"
              className="w-36 min-w-0"
              value={search.sort ?? "updated"}
              onChange={(v) =>
                void navigate({
                  to: "/vault",
                  search: (s: VaultSearch) => ({
                    ...s,
                    sort: v === "updated" ? undefined : (v as ItemFilters["sort"]),
                  }),
                  replace: true,
                })
              }
              options={[
                { value: "updated", label: "Recently updated" },
                { value: "recent", label: "Recently used" },
                { value: "frequent", label: "Most used" },
                { value: "name", label: "Name" },
                { value: "created", label: "Newest" },
              ]}
            />
          </div>
        </div>
        <div
          ref={listRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2"
        >
          {isLoading &&
            ["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => (
              <Skeleton key={k} className="h-12 rounded-lg" />
            ))}
          {!isLoading && items.length === 0 && (
            <Empty className="py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyRound />
                </EmptyMedia>
                <EmptyTitle>
                  {search.q ? "No matches" : search.trash ? "Trash is empty" : "Nothing here yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {search.q
                    ? "Search looks at names, sites, usernames, providers, projects and tags."
                    : "Save a login, an API key or anything else you need to keep safe."}
                </EmptyDescription>
              </EmptyHeader>
              {!search.trash && (
                <Button size="sm" onClick={() => openEditor({})}>
                  <Plus /> New item
                </Button>
              )}
            </Empty>
          )}
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              active={item.id === search.item}
              onSelect={() => select(item.id)}
            />
          ))}
          {isFetchingNextPage && <Skeleton className="h-12 rounded-lg" />}
        </div>
      </div>
      <div className={cn("min-w-0 flex-1 overflow-y-auto", !search.item && "hidden md:block")}>
        {search.item ? (
          <ItemDetail key={search.item} id={search.item} onClose={() => select(undefined)} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
            <div>
              <p>Select an item to see its details.</p>
              {items[0] && (
                <p className="mt-1 text-xs">Last change {timeAgo(items[0].updatedAt)}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}
