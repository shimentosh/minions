import type { DatabaseProperty, PageDetail, PageMeta, PagePropValue } from "@minions/core";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  CornerUpRight,
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
import { PageIcon, toggleArchive, trashPage } from "@/components/pages/page-tree";
import { openMovePage } from "@/components/pages/pages-context";
import { SnippetLine } from "@/components/pages/snippet-line";
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
import { type PageHit, type Snippet, searchAllPages, usePageSearchIndex } from "@/lib/pages/search";
import {
  ancestorsOf,
  archivedRoots,
  childrenOf,
  type PageEntry,
  type PageIndex,
  pageTitle,
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

/** "Delete permanently", after a confirmation: it cannot be undone. */
function PurgeButton({
  page,
  onDone,
  size = "xs",
  variant = "destructive-outline",
}: {
  page: Pick<PageEntry, "id" | "title">;
  onDone?: () => void;
  size?: "xs";
  variant?: "destructive-outline" | "ghost";
}) {
  const actions = usePageActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        <Trash2 /> Delete permanently
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pageTitle(page)}” permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              The page, its sub-pages, their history and files are erased. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() => {
                setBusy(true);
                void actions.purge(page.id).then(
                  () => {
                    setOpen(false);
                    toast.success("Deleted permanently");
                    onDone?.();
                  },
                  (e) => {
                    setBusy(false);
                    toast.error(errorMessage(e));
                  },
                );
              }}
            >
              Delete permanently
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
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

  // One save at a time: each is based on the revision the previous one returned.
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const flush = useCallback(async (): Promise<void> => {
    if (!latest.current.page) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    const cur = { ...latest.current, page: latest.current.page };
    setSave("saving");
    const run = (async () => {
      try {
        const updated = await savePage(cur.page, cur.meta, cur.content);
        latest.current.page = updated;
        qc.setQueryData<OpenPage>([...PAGES_KEY, "page", updated.id], (old) =>
          old ? { ...old, detail: updated, meta: cur.meta, content: cur.content } : old,
        );
        if (!again.current && !timer.current) setSave("saved");
        void actions.refresh();
      } catch (e) {
        again.current = false;
        setSave("error");
        toast.error(
          errorMessage(e),
          e instanceof ApiError && e.code === "REVISION_CONFLICT"
            ? "Reload the page to get the latest version."
            : undefined,
        );
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
    if (again.current) {
      again.current = false;
      await flush();
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

  // Closing the tab or reloading before the last edit is saved asks first.
  useEffect(() => {
    if (save !== "dirty" && save !== "saving" && save !== "error") return;
    const warn = (e: BeforeUnloadEvent) => {
      if (timer.current) void flush();
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save, flush]);

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
            aria-label={entry?.favorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={!!entry?.favorite}
            title={entry?.favorite ? "Remove from favorites" : "Add to favorites"}
            disabled={trashed || !entry}
            onClick={() => void actions.favorite(id, !entry?.favorite)}
          >
            <Star className={entry?.favorite ? "fill-amber-400 text-amber-400" : ""} />
          </Button>
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
              <MoreHorizontal />
            </MenuTrigger>
            <MenuPopup align="end">
              {!trashed && entry && (
                <MenuItem onClick={() => void actions.favorite(id, !entry.favorite)}>
                  <Star />
                  {entry.favorite ? "Remove from favorites" : "Add to favorites"}
                </MenuItem>
              )}
              {!trashed && (
                <MenuItem onClick={() => openMovePage(id)}>
                  <CornerUpRight /> Move to…
                </MenuItem>
              )}
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
                    void trashPage(actions, id).then(
                      (done) => done && void navigate({ to: "/pages" }),
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
            <PurgeButton
              page={{ id, title }}
              onDone={() => void navigate({ to: "/pages", search: { view: "trash" } })}
            />
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
            // biome-ignore lint/a11y/noAutofocus: a new page opens with its title ready to type, as in Notion
            autoFocus={!trashed && !data.meta.title && !data.content}
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
  snippets,
}: {
  rows: PageEntry[];
  index: PageIndex;
  archived: Set<string>;
  selected: Set<string>;
  onSelect: (id: string, on: boolean) => void;
  detail?: (p: PageEntry) => string;
  /** Search results: the words found in each page's content. */
  snippets?: Map<string, Snippet | null>;
}) {
  return (
    <ul className="divide-y rounded-xl border">
      {rows.map((p) => {
        const path = ancestorsOf(index, p.id).map(pageTitle).join(" / ");
        const snippet = snippets?.get(p.id);
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
                {snippet && <SnippetLine snippet={snippet} />}
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

  // Titles and content; content search fills in as the index is built.
  const indexState = usePageSearchIndex(active.pages, !trash);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run as the index grows
  const hits = useMemo<PageHit[] | null>(
    () => (q.trim() ? searchAllPages(active.visible ?? [], q, 100) : null),
    [active.visible, q, indexState.indexed],
  );
  const results = useMemo(() => {
    if (hits) return hits.map((h) => h.page);
    const all = active.visible ?? [];
    return [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
  }, [active.visible, hits]);
  const snippets = useMemo(
    () => (hits ? new Map(hits.map((h) => [h.page.id, h.snippet])) : undefined),
    [hits],
  );

  // The archive: each archived group once, by its top page; found by title or content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run as the index grows
  const archivedHits = useMemo(() => {
    const roots = archivedRoots(active.index, active.archived);
    if (!q.trim()) return null;
    return searchAllPages(roots, q, 1000);
  }, [active.index, active.archived, q, indexState.indexed]);
  const archivedRows = useMemo(() => {
    const rows = archivedHits
      ? archivedHits.map((h) => h.page)
      : archivedRoots(active.index, active.archived);
    return rows.sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  }, [archivedHits, active.index, active.archived]);
  const archivedSnippets = useMemo(
    () => (archivedHits ? new Map(archivedHits.map((h) => [h.page.id, h.snippet])) : undefined),
    [archivedHits],
  );

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
                <PurgeButton page={p} variant="ghost" />
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
              <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 text-muted-foreground/70" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={
                  archiveView ? "Search archived pages…" : "Search page titles and content…"
                }
                className="ps-8"
                autoFocus
              />
            </div>
            {q.trim() && indexState.building && (
              <p className="text-muted-foreground text-xs">
                Searching titles now; reading page contents on this device ({indexState.indexed} of{" "}
                {indexState.total})…
              </p>
            )}
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
                  snippets={archivedSnippets}
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
                  snippets={snippets}
                />
              </>
            )}
            {!archiveView &&
              !active.isLoading &&
              results.length === 0 &&
              (active.pages ?? []).length > 0 && (
                <p className="rounded-xl border px-3 py-6 text-center text-muted-foreground text-sm">
                  {q.trim() ? "No page matches." : "Every page is archived."}
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
