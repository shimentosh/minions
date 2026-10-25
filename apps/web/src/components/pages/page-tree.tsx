import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  MoreHorizontal,
  Plus,
  Star,
  StarOff,
  Table2,
  Trash2,
} from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useState } from "react";
import { create } from "zustand";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SidebarGroup, SidebarGroupLabel, useSidebar } from "@/components/ui/sidebar";
import { errorMessage } from "@/lib/api";
import { useShowArchived } from "@/lib/archive";
import { cn } from "@/lib/cn";
import { usePageActions, usePageTree } from "@/lib/pages/queries";
import {
  ancestorsOf,
  childrenOf,
  isWithin,
  type PageEntry,
  type PageIndex,
  pageTitle,
  positionBetween,
} from "@/lib/pages/tree";
import { onVaultClosed } from "@/lib/session";
import { toast } from "@/lib/toast";

/** Which pages are expanded. Memory only: page ids are not kept in browser storage. */
const useExpanded = create<{ open: Set<string>; toggle: (id: string, on?: boolean) => void }>(
  (set) => ({
    open: new Set(),
    toggle: (id, on) =>
      set((s) => {
        const open = new Set(s.open);
        if (on ?? !open.has(id)) open.add(id);
        else open.delete(id);
        return { open };
      }),
  }),
);
onVaultClosed(() => useExpanded.setState({ open: new Set() }));

type DropZone = "before" | "inside" | "after";
let dragging: string | null = null;

export function PageIcon({ page, className }: { page: PageEntry; className?: string }) {
  if (page.icon)
    return (
      <span className={cn("w-4 shrink-0 text-center text-sm leading-none", className)}>
        {page.icon}
      </span>
    );
  const Icon = page.kind === "database" ? Table2 : FileText;
  return <Icon className={cn("size-4 shrink-0 text-sidebar-foreground/60", className)} />;
}

/** Archive or bring back a page and everything under it, with a toast. */
export async function toggleArchive(
  actions: ReturnType<typeof usePageActions>,
  ids: string[],
  archived: boolean,
) {
  try {
    await actions.archive(ids, archived);
    const n = ids.length;
    const what = n === 1 ? "Page" : `${n} pages`;
    if (archived)
      toast.success(
        `${what} archived`,
        useShowArchived.getState().show
          ? "Sub-pages went with it."
          : "Hidden with its sub-pages. Show archived pages to see them.",
      );
    else toast.success(`${what} brought back`);
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

function TreeRow({
  page,
  index,
  depth,
  activeId,
  archived,
}: {
  page: PageEntry;
  index: PageIndex;
  depth: number;
  activeId: string | undefined;
  archived: Set<string>;
}) {
  const isArchived = archived.has(page.id);
  const kids = childrenOf(index, page.id);
  const open = useExpanded((s) => s.open.has(page.id));
  const toggle = useExpanded((s) => s.toggle);
  const actions = usePageActions();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [zone, setZone] = useState<DropZone | null>(null);

  const addChild = async () => {
    try {
      const id = await actions.create({ parentId: page.id });
      toggle(page.id, true);
      if (isMobile) setOpenMobile(false);
      void navigate({ to: "/pages/$pageId", params: { pageId: id } });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const zoneOf = (e: DragEvent<HTMLDivElement>): DropZone => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const id = dragging;
    const z = zone;
    setZone(null);
    dragging = null;
    if (!id || !z || isWithin(index, page.id, id)) return;
    try {
      if (z === "inside") {
        const last = childrenOf(index, page.id).at(-1);
        await actions.move(id, {
          parentId: page.id,
          position: positionBetween(last?.position ?? null, null),
        });
        toggle(page.id, true);
      } else {
        const siblings = childrenOf(index, page.parentId).filter((p) => p.id !== id);
        const at = siblings.findIndex((p) => p.id === page.id);
        const before = z === "before" ? siblings[at - 1] : page;
        const after = z === "before" ? page : siblings[at + 1];
        await actions.move(id, {
          parentId: page.parentId,
          position: positionBetween(before?.position ?? null, after?.position ?? null),
        });
      }
    } catch (err) {
      toast.error("Couldn't move the page", errorMessage(err));
    }
  };

  return (
    <li>
      <div
        draggable
        onDragStart={(e) => {
          dragging = page.id;
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!dragging || isWithin(index, page.id, dragging)) return;
          e.preventDefault();
          setZone(zoneOf(e));
        }}
        onDragLeave={() => setZone(null)}
        onDrop={(e) => void onDrop(e)}
        className={cn(
          "group/row relative flex h-8 items-center gap-1 rounded-md pe-1 text-sm hover:bg-sidebar-accent",
          activeId === page.id && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
          zone === "inside" && "bg-primary/10 ring-1 ring-primary/50 ring-inset",
        )}
        style={{ paddingInlineStart: 4 + depth * 12 }}
      >
        {zone === "before" && (
          <span className="absolute inset-x-1 top-0 h-0.5 rounded bg-primary" />
        )}
        {zone === "after" && (
          <span className="absolute inset-x-1 bottom-0 h-0.5 rounded bg-primary" />
        )}
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          onClick={() => toggle(page.id)}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 hover:bg-sidebar-border/60",
            !kids.length && "invisible",
          )}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <Link
          to="/pages/$pageId"
          params={{ pageId: page.id }}
          onClick={() => isMobile && setOpenMobile(false)}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <PageIcon page={page} className={cn(isArchived && "opacity-50")} />
          <span className={cn("truncate", isArchived && "text-sidebar-foreground/50 italic")}>
            {pageTitle(page)}
          </span>
          {page.archivedAt && (
            <Archive className="size-3 shrink-0 text-sidebar-foreground/40" aria-label="Archived" />
          )}
        </Link>
        <div className="flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 has-[[data-popup-open]]:opacity-100">
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Page actions"
                  className="flex size-6 items-center justify-center rounded hover:bg-sidebar-border/60"
                />
              }
            >
              <MoreHorizontal className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuItem onClick={() => void actions.favorite(page.id, !page.favorite)}>
                {page.favorite ? <StarOff /> : <Star />}
                {page.favorite ? "Remove from favorites" : "Add to favorites"}
              </MenuItem>
              <MenuItem onClick={() => void toggleArchive(actions, [page.id], !isArchived)}>
                {isArchived ? <ArchiveRestore /> : <Archive />}
                {isArchived ? "Unarchive" : "Archive"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                onClick={() =>
                  void actions.trash(page.id).then(
                    () => {
                      toast.success("Moved to trash", "Sub-pages went with it.");
                      if (activeId && isWithin(index, activeId, page.id))
                        void navigate({ to: "/pages" });
                    },
                    (e) => toast.error(errorMessage(e)),
                  )
                }
              >
                <Trash2 /> Move to trash
              </MenuItem>
            </MenuPopup>
          </Menu>
          <button
            type="button"
            aria-label="Add a page inside"
            title="Add a page inside"
            onClick={() => void addChild()}
            className="flex size-6 items-center justify-center rounded hover:bg-sidebar-border/60"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>
      {open && kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <TreeRow
              key={k.id}
              page={k}
              index={index}
              depth={depth + 1}
              activeId={activeId}
              archived={archived}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center">
      <SidebarGroupLabel className="h-7 flex-1 px-0 text-sidebar-accent-foreground">
        {children}
      </SidebarGroupLabel>
      {action}
    </div>
  );
}

/** The Pages section of the sidebar: favorites, then the nested tree. */
export function PageTreeSection() {
  const { visibleIndex: index, visible: pages, archived, isLoading } = usePageTree();
  const showArchived = useShowArchived((s) => s.show);
  const setShowArchived = useShowArchived((s) => s.setShow);
  const location = useRouterState({ select: (s) => s.location });
  const activeId = location.pathname.match(/^\/pages\/([0-9a-f-]{36})/)?.[1];
  const toggle = useExpanded((s) => s.toggle);
  const actions = usePageActions();
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);

  // Opening a page (link, search, import) reveals it in the tree.
  useEffect(() => {
    if (!activeId || !index.byId.has(activeId)) return;
    for (const a of ancestorsOf(index, activeId)) toggle(a.id, true);
  }, [activeId, index, toggle]);

  const top = childrenOf(index, null);
  const favorites = (pages ?? []).filter((p) => p.favorite);

  const addTop = async () => {
    try {
      const id = await actions.create({ parentId: null });
      void navigate({ to: "/pages/$pageId", params: { pageId: id } });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/collapsible">
      <SidebarGroup className="gap-1 p-2">
        {favorites.length > 0 && (
          <>
            <SectionLabel>Favorites</SectionLabel>
            <ul className="mb-1">
              {favorites.map((p) => (
                <li key={p.id}>
                  <Link
                    to="/pages/$pageId"
                    params={{ pageId: p.id }}
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-md ps-3 text-sm hover:bg-sidebar-accent",
                      activeId === p.id && "bg-sidebar-accent font-medium",
                    )}
                  >
                    <PageIcon page={p} />
                    <span className="truncate">{pageTitle(p)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="flex items-center">
          <CollapsibleTrigger
            className="flex-1 data-panel-open:[&_svg]:rotate-90"
            render={
              <SidebarGroupLabel className="h-7 cursor-pointer justify-between px-0 text-sidebar-accent-foreground" />
            }
          >
            <span>Pages</span>
            <ChevronRight className="h-3.5 w-3.5 text-sidebar-foreground/60 transition-transform duration-200" />
          </CollapsibleTrigger>
          <button
            type="button"
            title="New page"
            onClick={() => void addTop()}
            className="flex size-6 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Plus className="size-3.5" />
            <span className="sr-only">New page</span>
          </button>
        </div>
        <CollapsiblePanel>
          <ul className="gap-0.5" onDragOver={(e) => dragging && e.preventDefault()}>
            {top.map((p) => (
              <TreeRow
                key={p.id}
                page={p}
                index={index}
                depth={0}
                activeId={activeId}
                archived={archived}
              />
            ))}
          </ul>
          {!isLoading && top.length === 0 && (
            <p className="px-3 py-1 text-sidebar-foreground/60 text-xs">
              Encrypted pages for docs, wikis and notes.
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-x-1 ps-1 [&>a]:h-7 [&>a]:whitespace-nowrap [&>a]:rounded-md [&>a]:px-2 [&>a]:text-sidebar-foreground/70 [&>a]:text-xs [&>a]:leading-7 [&>a:hover]:text-sidebar-accent-foreground">
            <Link to="/pages">All pages</Link>
            <Link to="/pages" search={{ view: "trash" }}>
              Trash
            </Link>
            <Link to="/import/notion">Import</Link>
            {archived.size > 0 && (
              <Link to="/pages" search={{ view: "archived" }}>
                Archived
              </Link>
            )}
          </div>
          {archived.size > 0 && (
            <button
              type="button"
              aria-pressed={showArchived}
              onClick={() => setShowArchived(!showArchived)}
              className="mt-0.5 flex h-7 items-center gap-1.5 rounded-md ps-3 text-sidebar-foreground/70 text-xs hover:text-sidebar-accent-foreground"
            >
              {showArchived ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {showArchived
                ? "Hide archived pages"
                : `Show ${archived.size} archived page${archived.size === 1 ? "" : "s"}`}
            </button>
          )}
        </CollapsiblePanel>
      </SidebarGroup>
    </Collapsible>
  );
}
