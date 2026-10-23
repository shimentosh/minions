import type { DatabaseProperty, PageDetail, PageMeta, PagePropValue } from "@minions/core";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  FileText,
  FileUp,
  Lock,
  MoreHorizontal,
  Plus,
  SearchIcon,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Page } from "@/components/layout/page";
import { PageEditor } from "@/components/pages/page-editor";
import { PageIcon, toggleArchive } from "@/components/pages/page-tree";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, errorMessage } from "@/lib/api";
import { useShowArchived } from "@/lib/archive";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { type PageContent, pageKeyOf, uploadPageFile } from "@/lib/pages/crypto";
import {
  type OpenPage,
  PAGES_KEY,
  savePage,
  usePage,
  usePageActions,
  usePageTree,
} from "@/lib/pages/queries";
import { EMPTY_DOC } from "@/lib/pages/schema";
import {
  ancestorsOf,
  archivedRoots,
  childrenOf,
  type PageEntry,
  type PageIndex,
  pageTitle,
  searchPages,
} from "@/lib/pages/tree";
import { toast } from "@/lib/toast";

export interface PagesSearch {
  view?: "trash" | "archived";
}

const MAX_FILE = 25 * 1024 * 1024;
const ICONS = [
  "📄",
  "📝",
  "📚",
  "📌",
  "💡",
  "✅",
  "🗂️",
  "🔑",
  "🏠",
  "💼",
  "🚀",
  "🧪",
  "📊",
  "🗓️",
  "⭐",
  "❤️",
];

type SaveState = "saved" | "saving" | "dirty" | "error";

function IconPicker({
  icon,
  onChange,
  disabled,
}: {
  icon?: string;
  onChange: (icon?: string) => void;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState("");
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            className="flex size-12 items-center justify-center rounded-lg text-4xl hover:bg-accent"
            aria-label="Change icon"
          />
        }
      >
        {icon ?? <FileText className="size-8 text-muted-foreground/60" />}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-64">
        <div className="grid grid-cols-8 gap-1">
          {ICONS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => onChange(e)}
              className="rounded p-1 text-xl hover:bg-accent"
            >
              {e}
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-1">
          <Input
            size="sm"
            value={custom}
            placeholder="Any emoji"
            onChange={(e) => setCustom(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => custom.trim() && onChange([...custom.trim()].slice(0, 2).join(""))}
          >
            Set
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
            Remove
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function formatProp(value: PagePropValue | undefined, type: DatabaseProperty["type"]): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (type === "checkbox") return value ? "✓" : "";
  return String(value);
}

/** A database: its rows are its child pages, each with property values. */
function DatabaseTable({ open, rows }: { open: OpenPage; rows: PageEntry[] }) {
  const props = (open.content?.schema?.properties ?? []).filter((p) => p.type !== "title");
  const actions = usePageActions();
  const navigate = useNavigate();
  return (
    <div className="overflow-x-auto px-4 pb-6 md:px-12">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground text-xs">
            <th className="py-2 pe-3 font-medium">Name</th>
            {props.map((p) => (
              <th key={p.id} className="py-2 pe-3 font-medium">
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-border/60 border-b hover:bg-accent/40">
              <td className="py-1.5 pe-3">
                <Link
                  to="/pages/$pageId"
                  params={{ pageId: r.id }}
                  className="flex items-center gap-1.5 font-medium"
                >
                  <PageIcon page={r} />
                  <span className="truncate">{pageTitle(r)}</span>
                </Link>
              </td>
              {props.map((p) => (
                <td key={p.id} className="max-w-64 truncate py-1.5 pe-3 text-muted-foreground">
                  {formatProp(r.props?.[p.id], p.type)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Button
        size="sm"
        variant="ghost"
        className="mt-2"
        onClick={() =>
          void actions
            .create({ parentId: open.detail.id })
            .then((id) => navigate({ to: "/pages/$pageId", params: { pageId: id } }))
        }
      >
        <Plus /> New row
      </Button>
    </div>
  );
}

function PageView({ id }: { id: string }) {
  const { data, isLoading, error } = usePage(id);
  const { index, archived } = usePageTree();
  const showArchived = useShowArchived((s) => s.show);
  const actions = usePageActions();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState<string | undefined>();
  const [save, setSave] = useState<SaveState>("saved");
  const latest = useRef<{ page: PageDetail | null; meta: PageMeta; content: PageContent | null }>({
    page: null,
    meta: { title: "" },
    content: null,
  });
  const timer = useRef<number | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per page; later updates come from our own saves
  useEffect(() => {
    if (!data) return;
    latest.current = { page: data.detail, meta: data.meta, content: data.content };
    setTitle(data.meta.title ?? "");
    setIcon(data.meta.icon);
  }, [data?.detail.id]);

  const flush = useCallback(async () => {
    const cur = latest.current;
    if (!cur.page) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setSave("saving");
    try {
      const updated = await savePage(cur.page, cur.meta, cur.content);
      latest.current.page = updated;
      qc.setQueryData<OpenPage>([...PAGES_KEY, "page", updated.id], (old) =>
        old ? { ...old, detail: updated, meta: cur.meta, content: cur.content } : old,
      );
      setSave("saved");
      void actions.refresh();
    } catch (e) {
      setSave("error");
      toast.error(
        errorMessage(e),
        e instanceof ApiError && e.code === "REVISION_CONFLICT"
          ? "Reload the page to get the latest version."
          : undefined,
      );
    }
  }, [qc, actions]);

  const schedule = useCallback(() => {
    setSave("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 800);
  }, [flush]);

  // Save pending edits when leaving the page.
  useEffect(
    () => () => {
      if (timer.current) void flush();
    },
    [flush],
  );

  const upload = useCallback(
    async (file: File): Promise<{ fileId: string; name: string; size: number } | null> => {
      const page = latest.current.page;
      if (!page) return null;
      if (file.size > MAX_FILE) {
        toast.error("File is too large", "Files up to 25 MB can be added to a page.");
        return null;
      }
      try {
        const key = await pageKeyOf(page);
        const fileId = await uploadPageFile(
          page.id,
          key,
          new Uint8Array(await file.arrayBuffer()),
          {
            name: file.name,
            type: file.type || "application/octet-stream",
          },
        );
        return { fileId, name: file.name, size: file.size };
      } catch (e) {
        toast.error("Upload failed", errorMessage(e));
        return null;
      }
    },
    [],
  );

  const editorActions = useMemo(
    () => ({
      pickFile: (kind: "image" | "file") =>
        new Promise<{ fileId: string; name: string; size: number } | null>((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          if (kind === "image") input.accept = "image/*";
          input.onchange = () => {
            const f = input.files?.[0];
            resolve(f ? upload(f) : null);
          };
          input.click();
        }),
      createSubPage: async () => {
        try {
          return await actions.create({ parentId: id });
        } catch (e) {
          toast.error(errorMessage(e));
          return null;
        }
      },
    }),
    [actions, id, upload],
  );

  if (isLoading) return <Skeleton className="m-8 h-64" />;
  if (error || !data)
    return (
      <p className="p-8 text-muted-foreground text-sm">
        {error ? errorMessage(error) : "Not found"}
      </p>
    );

  const page = latest.current.page ?? data.detail;
  const trashed = !!page.deletedAt;
  const entry = index.byId.get(id);
  const isArchived = archived.has(id);
  const crumbs = ancestorsOf(index, id);
  // Inside an archived page everything shows; elsewhere archived sub-pages follow the switch.
  const kids = childrenOf(index, id).filter(
    (k) => showArchived || isArchived || !archived.has(k.id),
  );
  const isDatabase = page.kind === "database";

  return (
    <Page
      title={title.trim() || "Untitled"}
      crumbs={[
        { label: "Pages", to: "/pages" },
        ...crumbs.map((c) => ({ label: pageTitle(c), to: `/pages/${c.id}` })),
      ]}
      actions={
        <>
          <span
            className={cn(
              "text-xs",
              save === "error" ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {save === "saving"
              ? "Saving…"
              : save === "dirty"
                ? "Edited"
                : save === "error"
                  ? "Not saved"
                  : `Saved ${timeAgo(page.updatedAt)}`}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Favorite"
            disabled={trashed}
            onClick={() => void actions.favorite(id, !entry?.favorite)}
          >
            <Star className={entry?.favorite ? "fill-amber-400 text-amber-400" : ""} />
          </Button>
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
              <MoreHorizontal />
            </MenuTrigger>
            <MenuPopup align="end">
              {!trashed && (
                <MenuItem onClick={() => void toggleArchive(actions, [id], !isArchived)}>
                  {isArchived ? <ArchiveRestore /> : <Archive />}
                  {isArchived ? "Unarchive" : "Archive with sub-pages"}
                </MenuItem>
              )}
              {!trashed && (
                <MenuItem
                  variant="destructive"
                  onClick={() =>
                    void actions.trash(id).then(
                      () => {
                        toast.success("Moved to trash");
                        void navigate({ to: "/pages" });
                      },
                      (e) => toast.error(errorMessage(e)),
                    )
                  }
                >
                  <Trash2 /> Move to trash
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        </>
      }
    >
      <div className="mx-auto w-full max-w-4xl">
        {isArchived && !trashed && (
          <div className="mx-4 mt-4 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm md:mx-12">
            <Archive className="size-4 text-muted-foreground" />
            {entry?.archivedAt
              ? "This page is archived. It is hidden from the page tree and search."
              : "This page is inside an archived page. It is hidden from the page tree and search."}
            <Button
              size="xs"
              variant="outline"
              onClick={() => void toggleArchive(actions, [id], false)}
            >
              <ArchiveRestore /> Unarchive
            </Button>
          </div>
        )}
        {trashed && (
          <div className="mx-4 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm md:mx-12">
            This page is in the trash.
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void actions
                  .restore(id)
                  .then(() => qc.invalidateQueries({ queryKey: [...PAGES_KEY, "page", id] }))
              }
            >
              <ArchiveRestore /> Restore
            </Button>
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={() =>
                void actions
                  .purge(id)
                  .then(() => navigate({ to: "/pages", search: { view: "trash" } }))
              }
            >
              <Trash2 /> Delete permanently
            </Button>
          </div>
        )}
        <div className="px-4 pt-8 md:px-12 md:pt-14">
          <IconPicker
            icon={icon}
            disabled={trashed}
            onChange={(next) => {
              setIcon(next);
              latest.current.meta = { ...latest.current.meta, icon: next };
              if (!next) delete latest.current.meta.icon;
              schedule();
            }}
          />
          <textarea
            value={title}
            rows={1}
            onChange={(e) => {
              setTitle(e.target.value);
              latest.current.meta = {
                ...latest.current.meta,
                title: e.target.value.replace(/\n/g, " "),
              };
              schedule();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (document.querySelector(".page-prose .ProseMirror") as HTMLElement | null)?.focus();
              }
            }}
            placeholder="Untitled"
            disabled={trashed}
            className="mt-2 field-sizing-content w-full resize-none bg-transparent font-bold text-4xl leading-tight outline-none placeholder:text-muted-foreground/40"
          />
          <p className="mt-1 flex items-center gap-1 text-muted-foreground text-xs">
            <Lock className="size-3" /> End-to-end encrypted
          </p>
        </div>
        {isDatabase ? (
          <div className="pt-4">
            <DatabaseTable open={data} rows={kids} />
          </div>
        ) : (
          <PageEditor
            key={id}
            page={page}
            doc={data.content?.doc ?? EMPTY_DOC}
            editable={!trashed}
            className="px-4 pt-4 pb-24 md:px-12"
            onChange={(doc) => {
              latest.current.content = { v: 1, doc };
              schedule();
            }}
            onOpenPage={(pageId) => void navigate({ to: "/pages/$pageId", params: { pageId } })}
            onOpenItem={(item) => void navigate({ to: "/vault", search: { item } })}
            actions={editorActions}
            onPasteImage={async (f) => (await upload(f))?.fileId ?? null}
          />
        )}
        {!isDatabase && kids.length > 0 && (
          <div className="mx-4 mb-16 border-t pt-4 md:mx-12">
            <h2 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Pages inside
            </h2>
            <ul className="grid gap-0.5">
              {kids.map((k) => (
                <li key={k.id}>
                  <Link
                    to="/pages/$pageId"
                    params={{ pageId: k.id }}
                    className="flex h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent"
                  >
                    <PageIcon page={k} />
                    <span className="truncate">{pageTitle(k)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Page>
  );
}

export function PageRoute() {
  const { pageId } = useParams({ strict: false }) as { pageId: string };
  return <PageView key={pageId} id={pageId} />;
}

/** A list of pages that can be ticked for bulk archiving. */
function PageRows({
  rows,
  index,
  archived,
  selected,
  onSelect,
  detail,
}: {
  rows: PageEntry[];
  index: PageIndex;
  archived: Set<string>;
  selected: Set<string>;
  onSelect: (id: string, on: boolean) => void;
  detail?: (p: PageEntry) => string;
}) {
  return (
    <ul className="divide-y rounded-xl border">
      {rows.map((p) => {
        const path = ancestorsOf(index, p.id).map(pageTitle).join(" / ");
        return (
          <li key={p.id} className="flex items-center gap-2 ps-3 hover:bg-accent/50">
            <input
              type="checkbox"
              checked={selected.has(p.id)}
              aria-label={`Select ${pageTitle(p)}`}
              onChange={(e) => onSelect(p.id, e.target.checked)}
            />
            <Link
              to="/pages/$pageId"
              params={{ pageId: p.id }}
              className="flex min-w-0 flex-1 items-center gap-2 py-2 pe-3 text-sm"
            >
              <PageIcon page={p} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{pageTitle(p)}</span>
                {path && (
                  <span className="block truncate text-muted-foreground text-xs">{path}</span>
                )}
              </span>
              {archived.has(p.id) && (
                <Badge variant="outline" size="sm">
                  <Archive className="size-3" /> Archived
                </Badge>
              )}
              <span className="shrink-0 text-muted-foreground text-xs">
                {detail ? detail(p) : timeAgo(p.updatedAt)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** All pages: search titles, recent pages, the archive and the trash. */
export function PagesHome() {
  const search = useSearch({ strict: false }) as PagesSearch;
  const trash = search.view === "trash";
  const archiveView = search.view === "archived";
  const active = usePageTree();
  const trashed = usePageTree("trash");
  const actions = usePageActions();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const showArchived = useShowArchived((s) => s.show);
  const setShowArchived = useShowArchived((s) => s.setShow);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view starts with nothing ticked or searched
  useEffect(() => {
    setSelected(new Set());
    setQ("");
  }, [search.view]);
  const onSelect = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const results = useMemo(() => {
    const all = active.visible ?? [];
    if (q.trim()) return searchPages(all, q);
    return [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
  }, [active.visible, q]);

  // The archive: each archived group once, by its top page.
  const archivedRows = useMemo(() => {
    const roots = archivedRoots(active.index, active.archived);
    return (q.trim() ? searchPages(roots, q, 1000) : roots).sort((a, b) =>
      (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""),
    );
  }, [active.index, active.archived, q]);

  const shown = archiveView ? archivedRows : results;
  const picked = shown.filter((p) => selected.has(p.id));
  const pickedArchived = picked.length > 0 && picked.every((p) => active.archived.has(p.id));
  const bulk = async () => {
    await toggleArchive(
      actions,
      picked.map((p) => p.id),
      !pickedArchived,
    );
    setSelected(new Set());
  };

  // Trash: show each deleted group once, by its top page.
  const trashRoots = useMemo(() => {
    const rows = trashed.pages ?? [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return rows.filter((r) => {
      const parent = r.parentId ? byId.get(r.parentId) : undefined;
      return !parent || parent.deletedAt !== r.deletedAt;
    });
  }, [trashed.pages]);

  const newPage = async () => {
    try {
      const id = await actions.create({ parentId: null });
      void navigate({ to: "/pages/$pageId", params: { pageId: id } });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Page
      title={trash ? "Trash" : archiveView ? "Archived pages" : "Pages"}
      crumbs={trash || archiveView ? [{ label: "Pages", to: "/pages" }] : []}
      actions={
        <>
          <Button size="xs" variant="outline" render={<Link to="/import/notion" />}>
            <FileUp /> Import from Notion
          </Button>
          <Button size="xs" onClick={() => void newPage()}>
            <Plus /> New page
          </Button>
        </>
      }
    >
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 md:px-8">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={trash || archiveView ? "ghost" : "secondary"}
            render={<Link to="/pages" />}
          >
            Pages
          </Button>
          <Button
            size="sm"
            variant={archiveView ? "secondary" : "ghost"}
            render={<Link to="/pages" search={{ view: "archived" }} />}
          >
            <Archive /> Archived
            {active.archived.size > 0 && (
              <span className="text-muted-foreground tabular-nums">{archivedRows.length}</span>
            )}
          </Button>
          <Button
            size="sm"
            variant={trash ? "secondary" : "ghost"}
            render={<Link to="/pages" search={{ view: "trash" }} />}
          >
            <Trash2 /> Trash
          </Button>
        </div>
        {trash ? (
          <ul className="divide-y rounded-xl border">
            {trashRoots.map((p) => (
              <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <PageIcon page={p} />
                <Link
                  to="/pages/$pageId"
                  params={{ pageId: p.id }}
                  className="min-w-0 flex-1 truncate"
                >
                  {pageTitle(p)}
                </Link>
                <span className="text-muted-foreground text-xs">
                  {p.deletedAt ? timeAgo(p.deletedAt) : ""}
                </span>
                <Button size="xs" variant="ghost" onClick={() => void actions.restore(p.id)}>
                  <ArchiveRestore /> Restore
                </Button>
                <Button size="xs" variant="ghost" onClick={() => void actions.purge(p.id)}>
                  <Trash2 /> Delete
                </Button>
              </li>
            ))}
            {!trashed.isLoading && trashRoots.length === 0 && (
              <li className="px-3 py-6 text-center text-muted-foreground text-sm">
                The trash is empty.
              </li>
            )}
          </ul>
        ) : (
          <>
            <div className="relative">
              <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-4 text-muted-foreground/70" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={archiveView ? "Search archived pages…" : "Search page titles…"}
                className="ps-8"
                autoFocus
              />
            </div>
            <div className="flex min-h-7 flex-wrap items-center gap-2 text-sm">
              {!archiveView && active.archived.size > 0 && (
                <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <input
                    type="checkbox"
                    checked={showArchived}
                    onChange={(e) => setShowArchived(e.target.checked)}
                  />
                  Show archived pages ({active.archived.size})
                </label>
              )}
              {shown.length > 0 && (
                <button
                  type="button"
                  className="text-muted-foreground text-xs hover:text-foreground"
                  onClick={() =>
                    setSelected(
                      picked.length === shown.length ? new Set() : new Set(shown.map((p) => p.id)),
                    )
                  }
                >
                  {picked.length === shown.length ? "Select none" : "Select all"}
                </button>
              )}
              {picked.length > 0 && (
                <Button size="xs" variant="outline" className="ms-auto" onClick={() => void bulk()}>
                  {pickedArchived ? <ArchiveRestore /> : <Archive />}
                  {pickedArchived ? "Unarchive" : "Archive"} {picked.length} page
                  {picked.length === 1 ? "" : "s"}
                </Button>
              )}
            </div>
            {active.isLoading && <Skeleton className="h-40" />}
            {archiveView && !active.isLoading && archivedRows.length === 0 && (
              <p className="rounded-xl border px-3 py-6 text-center text-muted-foreground text-sm">
                {q.trim()
                  ? "No archived page matches."
                  : "Nothing is archived. Pages from a Notion import land here."}
              </p>
            )}
            {archiveView && archivedRows.length > 0 && (
              <>
                <p className="text-muted-foreground text-xs">
                  Archived pages and their sub-pages are hidden from the page tree and search.
                  Unarchive a page to bring it back with everything under it.
                </p>
                <PageRows
                  rows={archivedRows}
                  index={active.index}
                  archived={active.archived}
                  selected={selected}
                  onSelect={onSelect}
                  detail={(p) => (p.archivedAt ? `archived ${timeAgo(p.archivedAt)}` : "")}
                />
              </>
            )}
            {!archiveView && !active.isLoading && (active.pages ?? []).length === 0 && (
              <Empty className="py-14">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileText />
                  </EmptyMedia>
                  <EmptyTitle>No pages yet</EmptyTitle>
                  <EmptyDescription>
                    Pages are encrypted on this device: titles, content and files. Start one, or
                    bring your Notion workspace over.
                  </EmptyDescription>
                </EmptyHeader>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void newPage()}>
                    <Plus /> New page
                  </Button>
                  <Button size="sm" variant="outline" render={<Link to="/import/notion" />}>
                    <FileUp /> Import from Notion
                  </Button>
                </div>
              </Empty>
            )}
            {!archiveView && results.length > 0 && (
              <>
                <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  {q.trim() ? `${results.length} found` : "Recently edited"}
                </h2>
                <PageRows
                  rows={results}
                  index={active.index}
                  archived={active.archived}
                  selected={selected}
                  onSelect={onSelect}
                />
              </>
            )}
            {!archiveView &&
              !active.isLoading &&
              results.length === 0 &&
              (active.pages ?? []).length > 0 && (
                <p className="rounded-xl border px-3 py-6 text-center text-muted-foreground text-sm">
                  {q.trim() ? "No page title matches." : "Every page is archived."}
                  {active.archived.size > 0 && !showArchived && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => setShowArchived(true)}
                      >
                        Include archived pages
                      </button>
                    </>
                  )}
                </p>
              )}
          </>
        )}
      </div>
    </Page>
  );
}
