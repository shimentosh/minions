import type { WorkspaceItemSummary } from "@minions/core";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { FolderPlus, KeyRound, Plus, SearchIcon, ShieldAlert, Star, Trash2 } from "lucide-react";
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
import {
  accessLabel,
  WorkspaceItemDetailView,
} from "@/components/workspaces/workspace-item-detail";
import { WorkspaceBanners, WorkspaceTabs } from "@/components/workspaces/workspace-shell";
import { del, errorMessage, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ItemGlyph } from "@/lib/item-icons";
import type { ItemFilters } from "@/lib/queries";
import { toast } from "@/lib/toast";
import { useUi } from "@/lib/ui-store";
import {
  useInvalidateWorkspaces,
  useWorkspace,
  useWorkspaceFolders,
  useWorkspaceItems,
  useWorkspaceTags,
} from "@/lib/workspace-queries";

export type WorkspaceView = "all" | "favorites" | "recent" | "added" | "trash";

export interface WorkspaceSearch {
  q?: string;
  show?: WorkspaceView;
  folderId?: string;
  tag?: string;
  item?: string;
}

const VIEWS: { value: WorkspaceView; label: string }[] = [
  { value: "all", label: "All credentials" },
  { value: "favorites", label: "Favorites" },
  { value: "recent", label: "Recently used" },
  { value: "added", label: "Recently added" },
  { value: "trash", label: "Trash" },
];

function Row({
  item,
  active,
  onSelect,
}: {
  item: WorkspaceItemSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const a = accessLabel(item);
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
          {item.rekeyNeeded && item.permission === "MANAGE" && (
            <ShieldAlert
              className="size-3 shrink-0 text-warning-foreground"
              aria-label="Key rotation needed"
            />
          )}
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          {[item.host, item.username].filter(Boolean).join(" · ") || item.subtitle || " "}
        </span>
      </span>
      <span
        className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground/80 sm:flex"
        title={a.label}
      >
        <a.icon className="size-3" /> {a.label}
      </span>
    </button>
  );
}

function NewFolder({
  workspaceId,
  onCreated,
}: {
  workspaceId: string;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const invalidate = useInvalidateWorkspaces();
  const create = useMutation({
    mutationFn: () =>
      post<{ id: string }>(`/workspaces/${workspaceId}/folders`, { name: name.trim() }),
    onSuccess: (f) => {
      setName("");
      setOpen(false);
      void invalidate();
      onCreated(f.id);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!open)
    return (
      <Button size="icon-sm" variant="ghost" onClick={() => setOpen(true)} aria-label="New folder">
        <FolderPlus />
      </Button>
    );
  return (
    <form
      className="flex gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      <Input
        size="sm"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Folder name"
        maxLength={80}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      />
      <Button size="sm" type="submit" loading={create.isPending}>
        Add
      </Button>
    </form>
  );
}

export function WorkspacePage() {
  const { workspaceId } = useParams({ strict: false }) as { workspaceId: string };
  const search = useSearch({ strict: false }) as WorkspaceSearch;
  const navigate = useNavigate();
  const openEditor = useUi((s) => s.openEditor);
  const { data: ws, error: wsError } = useWorkspace(workspaceId);
  const confirmed = ws?.status === "CONFIRMED";
  const { data: folders } = useWorkspaceFolders(confirmed ? workspaceId : undefined);
  const { data: tags } = useWorkspaceTags(workspaceId);
  const invalidate = useInvalidateWorkspaces();
  const [q, setQ] = useState(search.q ?? "");
  const listRef = useRef<HTMLDivElement>(null);
  const go = (patch: Partial<WorkspaceSearch>, replace = false) =>
    void navigate({
      to: "/w/$workspaceId",
      params: { workspaceId },
      search: (s: WorkspaceSearch) => ({ ...s, ...patch }),
      replace,
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the text changes; go is rebuilt every render
  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((search.q ?? "") !== q) go({ q: q || undefined }, true);
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, search.q]);

  const view = search.show ?? "all";
  const filters: ItemFilters = {
    q: search.q,
    collectionId: search.folderId,
    tag: search.tag,
    favorite: view === "favorites",
    trash: view === "trash",
    sort: view === "recent" ? "recent" : view === "added" ? "created" : undefined,
  };
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useWorkspaceItems(
    workspaceId,
    filters,
    confirmed,
  );
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const total = data?.pages[0]?.total;

  const deleteFolder = useMutation({
    mutationFn: (id: string) => del(`/workspaces/${workspaceId}/folders/${id}`),
    onSuccess: () => {
      go({ folderId: undefined });
      void invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

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

  if (wsError)
    return (
      <Page title="Workspace">
        <p className="p-6 text-muted-foreground text-sm">{errorMessage(wsError)}</p>
      </Page>
    );

  const isAdmin = ws?.role === "OWNER" || ws?.role === "ADMIN";

  return (
    <Page
      title={ws?.name ?? "Workspace"}
      crumbs={[{ label: "Workspaces", to: "/workspaces" }]}
      actions={<WorkspaceTabs workspaceId={workspaceId} />}
      fill
      className="flex-col"
    >
      {ws && <WorkspaceBanners ws={ws} />}
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "flex w-full flex-col border-border border-r md:w-[22rem] md:shrink-0 lg:w-96",
            search.item && "hidden md:flex",
          )}
        >
          <div className="space-y-2 border-border border-b p-3">
            <div className="flex gap-1.5 sm:hidden">
              <WorkspaceTabs workspaceId={workspaceId} />
            </div>
            <div className="flex gap-1.5">
              <div className="relative flex-1">
                <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 text-muted-foreground/70" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search name, site, username, folder, tag…"
                  className="ps-8"
                  size="sm"
                  disabled={!confirmed}
                />
              </div>
              <Button
                size="sm"
                disabled={!confirmed}
                onClick={() => openEditor({ workspaceId, collectionId: search.folderId ?? null })}
              >
                <Plus /> Add
              </Button>
            </div>
            <div className="flex items-center gap-1.5">
              <SimpleSelect
                size="sm"
                className="min-w-0 flex-1"
                value={view}
                onChange={(v) => go({ show: v === "all" ? undefined : (v as WorkspaceView) })}
                options={VIEWS}
              />
              <SimpleSelect
                size="sm"
                className="min-w-0 flex-1"
                value={search.folderId ?? ""}
                allowEmpty
                onChange={(v) => go({ folderId: v || undefined })}
                options={(folders ?? []).map((f) => ({
                  value: f.id,
                  label: `${f.name} (${f.itemCount})`,
                }))}
              />
              {confirmed && (
                <NewFolder workspaceId={workspaceId} onCreated={(id) => go({ folderId: id })} />
              )}
              {isAdmin && search.folderId && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Delete folder"
                  title="Delete folder (credentials stay)"
                  onClick={() => deleteFolder.mutate(search.folderId!)}
                >
                  <Trash2 />
                </Button>
              )}
            </div>
            {(tags?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1">
                {tags!.slice(0, 12).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => go({ tag: search.tag === t.name ? undefined : t.name })}
                    className={cn(
                      "rounded-md border px-1.5 py-0.5 text-xs",
                      search.tag === t.name
                        ? "border-primary bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent",
                    )}
                  >
                    #{t.name}
                  </button>
                ))}
              </div>
            )}
            <span className="block text-muted-foreground text-xs">
              {total !== undefined ? `${total} credential${total === 1 ? "" : "s"}` : " "}
            </span>
          </div>
          <div
            ref={listRef}
            onScroll={onScroll}
            className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2"
          >
            {confirmed &&
              isLoading &&
              ["a", "b", "c", "d", "e"].map((k) => (
                <Skeleton key={k} className="h-12 rounded-lg" />
              ))}
            {confirmed && !isLoading && items.length === 0 && (
              <Empty className="py-16">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <KeyRound />
                  </EmptyMedia>
                  <EmptyTitle>
                    {search.q
                      ? "No matches"
                      : view === "trash"
                        ? "Trash is empty"
                        : "No credentials yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {search.q
                      ? "Search covers names, sites, usernames, folders and tags. Passwords are never searched."
                      : "Add a login and choose who on the team can use it."}
                  </EmptyDescription>
                </EmptyHeader>
                {view !== "trash" && (
                  <Button size="sm" onClick={() => openEditor({ workspaceId })}>
                    <Plus /> Add credential
                  </Button>
                )}
              </Empty>
            )}
            {items.map((item) => (
              <Row
                key={item.id}
                item={item}
                active={item.id === search.item}
                onSelect={() => go({ item: item.id })}
              />
            ))}
            {isFetchingNextPage && <Skeleton className="h-12 rounded-lg" />}
          </div>
        </div>
        <div className={cn("min-w-0 flex-1 overflow-y-auto", !search.item && "hidden md:block")}>
          {search.item && confirmed ? (
            <WorkspaceItemDetailView
              key={search.item}
              workspaceId={workspaceId}
              id={search.item}
              onClose={() => go({ item: undefined })}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
              Select a credential to see its details and who can use it.
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
