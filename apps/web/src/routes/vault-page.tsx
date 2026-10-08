import { CATEGORY_LABELS, type ItemCategory } from "@minions/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { KeyRound, Plus, Rows3, SearchIcon, Table as TableIcon, X } from "lucide-react";
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
import { ItemRow } from "@/components/vault/item-row";
import { ItemTable } from "@/components/vault/item-table";
import { BulkBar } from "@/components/vault/organize";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { type ItemFilters, useCollections, useItems, useProjects } from "@/lib/queries";
import { useSelection } from "@/lib/selection";
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

const VIEW_KEY = "minions-vault-view";

/** Table or list, remembered on this device. Table is the default. */
function useVaultView() {
  const [view, setView] = useState<"table" | "list">(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "table";
    } catch {
      return "table";
    }
  });
  const set = (v: "table" | "list") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Private mode: the choice lasts for this visit only.
    }
  };
  return [view, set] as const;
}

export function VaultPage() {
  const search = useSearch({ strict: false }) as VaultSearch;
  const navigate = useNavigate();
  const openEditor = useUi((s) => s.openEditor);
  const { data: projects } = useProjects();
  const { data: collections } = useCollections();
  const [q, setQ] = useState(search.q ?? "");
  const listRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useVaultView();

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
  const selection = useSelection();

  // A new list starts with nothing ticked.
  const listKey = JSON.stringify(filters);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on list change only
  useEffect(() => selection.clear(), [listKey]);

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

  const filterLabel = search.tag ? { kind: "Tag", name: `#${search.tag}` } : null;

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

  const setSort = (v: string) =>
    void navigate({
      to: "/vault",
      search: (s: VaultSearch) => ({
        ...s,
        sort: v === "updated" ? undefined : (v as ItemFilters["sort"]),
      }),
      replace: true,
    });

  const searchBox = (
    <div className="relative min-w-0 flex-1">
      <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 text-muted-foreground/70" />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${title.toLowerCase()}…`}
        className="ps-8"
        size="sm"
      />
    </div>
  );

  const filterChip = filterLabel && (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-accent px-2 py-1 text-xs">
      <span className="text-muted-foreground">{filterLabel.kind}</span>
      <span className="truncate font-medium">{filterLabel.name}</span>
      <button
        type="button"
        aria-label="Clear filter"
        className="-mr-0.5 rounded text-muted-foreground hover:text-foreground"
        onClick={() =>
          void navigate({
            to: "/vault",
            search: (s: VaultSearch) => ({ ...s, tag: undefined }),
          })
        }
      >
        <X className="size-3.5" />
      </button>
    </span>
  );

  const count = (
    <span className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
      {total !== undefined ? `${total} item${total === 1 ? "" : "s"}` : " "}
      {view === "list" && items.length > 0 && (
        <button
          type="button"
          className="rounded px-1 text-foreground/70 hover:bg-accent hover:text-foreground"
          onClick={() =>
            selection.ids.size === items.length
              ? selection.clear()
              : selection.set(items.map((i) => i.id))
          }
        >
          {selection.ids.size === items.length ? "Select none" : "Select all"}
        </button>
      )}
    </span>
  );

  const setFilter = (key: "projectId" | "collectionId", v: string) =>
    void navigate({
      to: "/vault",
      search: (s: VaultSearch) => ({ ...s, [key]: v || undefined, item: undefined }),
    });

  const groupFilters = (
    <>
      <SimpleSelect
        size="sm"
        className={cn("w-40 min-w-0", search.projectId && "border-primary/40 bg-primary/5")}
        value={search.projectId ?? ""}
        onChange={(v) => setFilter("projectId", v)}
        allowEmpty
        emptyLabel="All projects"
        placeholder="All projects"
        options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
      />
      <SimpleSelect
        size="sm"
        className={cn("w-40 min-w-0", search.collectionId && "border-primary/40 bg-primary/5")}
        value={search.collectionId ?? ""}
        onChange={(v) => setFilter("collectionId", v)}
        allowEmpty
        emptyLabel="All collections"
        placeholder="All collections"
        options={(collections ?? []).map((c) => ({ value: c.id, label: c.name }))}
      />
    </>
  );

  const sortSelect = (
    <SimpleSelect
      size="sm"
      className="w-36 min-w-0"
      value={search.sort ?? "updated"}
      onChange={setSort}
      options={[
        { value: "updated", label: "Recently updated" },
        { value: "recent", label: "Recently used" },
        { value: "frequent", label: "Most used" },
        { value: "name", label: "Name" },
        { value: "created", label: "Newest" },
      ]}
    />
  );

  const viewToggle = (
    <div className="flex shrink-0 items-center rounded-lg border border-border p-0.5">
      {(
        [
          ["table", TableIcon, "Table view"],
          ["list", Rows3, "List view"],
        ] as const
      ).map(([v, Icon, label]) => (
        <button
          key={v}
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={view === v}
          onClick={() => setView(v)}
          className={cn(
            "flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground",
            view === v && "bg-accent text-foreground",
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );

  const loading = isLoading && (
    <div className="space-y-1 p-2">
      {["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => (
        <Skeleton key={k} className="h-12 rounded-lg" />
      ))}
    </div>
  );

  const empty = !isLoading && items.length === 0 && (
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
  );

  // Room so the last rows are not hidden under the bulk bar.
  const tail = (
    <>
      {isFetchingNextPage && <Skeleton className="m-2 h-12 rounded-lg" />}
      {selection.ids.size > 0 && <div className="h-16" />}
    </>
  );

  const crumbs =
    search.projectId || search.collectionId || search.tag ? [{ label: "Vault", to: "/vault" }] : [];

  if (view === "table")
    return (
      <Page title={title} crumbs={crumbs} fill>
        <div
          className={cn("relative flex min-w-0 flex-1 flex-col", search.item && "hidden md:flex")}
        >
          <div className="flex flex-wrap items-center gap-2 border-border border-b px-3 py-2.5">
            <div className="flex min-w-48 flex-1 items-center gap-2">
              {searchBox}
              {filterChip}
            </div>
            {groupFilters}
            {sortSelect}
            {viewToggle}
            {count}
          </div>
          <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
            {loading}
            {empty}
            {items.length > 0 && (
              <ItemTable
                items={items}
                activeId={search.item}
                onOpen={select}
                sort={search.sort ?? "updated"}
                onSort={setSort}
                trash={search.trash}
                compact={!!search.item}
              />
            )}
            {tail}
          </div>
          <BulkBar items={items} trash={search.trash} />
        </div>
        {search.item && (
          <aside className="flex w-full min-w-0 flex-col border-border border-l md:w-[28rem] md:shrink-0 xl:w-[32rem]">
            <div className="flex h-10 shrink-0 items-center justify-between border-border border-b px-3">
              <span className="text-muted-foreground text-xs">Details</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close details"
                onClick={() => select(undefined)}
              >
                <X />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ItemDetail key={search.item} id={search.item} onClose={() => select(undefined)} />
            </div>
          </aside>
        )}
      </Page>
    );

  return (
    <Page title={title} crumbs={crumbs} fill>
      <div
        className={cn(
          "relative flex w-full flex-col border-border border-r md:w-[24rem] md:shrink-0 lg:w-[26rem]",
          search.item && "hidden md:flex",
        )}
      >
        <div className="space-y-2 border-border border-b p-3">
          <div className="flex items-center gap-2">
            {searchBox}
            {viewToggle}
          </div>
          <div className="flex items-center gap-1.5 [&>*]:flex-1">{groupFilters}</div>
          {filterChip && <div className="flex items-center gap-1.5">{filterChip}</div>}
          <div className="flex items-center justify-between gap-2">
            {count}
            {sortSelect}
          </div>
        </div>
        <div
          ref={listRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2"
        >
          {loading}
          {empty}
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              list={items}
              trash={search.trash}
              active={item.id === search.item}
              onOpen={() => select(item.id)}
            />
          ))}
          {tail}
        </div>
        <BulkBar items={items} trash={search.trash} />
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
