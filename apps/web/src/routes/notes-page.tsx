import type { NoteDetail, NoteSummary } from "@minions/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  Clock,
  FileText,
  Lock,
  MoreHorizontal,
  NotebookText,
  Pin,
  PinOff,
  Plus,
  SearchIcon,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Page } from "@/components/layout/page";
import { NoteEditor } from "@/components/notes/note-editor";
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, del, errorMessage, patch, post, put } from "@/lib/api";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { useCollections, useNote, useNotes, useProjects } from "@/lib/queries";
import { toast } from "@/lib/toast";
import { decryptNote, encryptNote } from "@/lib/vault-crypto";

export interface NotesSearch {
  view?: "all" | "favorites" | "recent" | "archived" | "trash";
  q?: string;
  projectId?: string;
  collectionId?: string;
  tag?: string;
  note?: string;
}

const VIEWS: { value: NonNullable<NotesSearch["view"]>; label: string; icon: typeof FileText }[] = [
  { value: "all", label: "All notes", icon: FileText },
  { value: "favorites", label: "Favorites", icon: Star },
  { value: "recent", label: "Recent", icon: Clock },
  { value: "archived", label: "Archived", icon: Archive },
  { value: "trash", label: "Trash", icon: Trash2 },
];

type SaveState = "saved" | "saving" | "dirty" | "error";

function NoteView({ id, onGone }: { id: string; onGone: () => void }) {
  const { data: note, isLoading, error } = useNote(id);
  const qc = useQueryClient();
  const { data: projects } = useProjects();
  const { data: collections } = useCollections();
  const [html, setHtml] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [save, setSave] = useState<SaveState>("saved");
  const latest = useRef<{ note: NoteDetail | null; html: string; title: string; tags: string }>({
    note: null,
    html: "",
    title: "",
    tags: "",
  });
  const timer = useRef<number | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: decrypt once per note; later updates come from our own saves
  useEffect(() => {
    if (!note) return;
    let alive = true;
    decryptNote(note.id, note.contentEnc).then(
      (h) => {
        if (!alive) return;
        setHtml(h);
        setTitle(note.title);
        setTags(note.tags.join(", "));
        latest.current = { note, html: h, title: note.title, tags: note.tags.join(", ") };
      },
      () => toast.error("This note could not be decrypted"),
    );
    return () => {
      alive = false;
    };
    // Only on first load of this note; later updates come from our own saves.
  }, [note?.id]);

  const flush = useCallback(async () => {
    const cur = latest.current;
    if (!cur.note) return;
    setSave("saving");
    try {
      const updated = await put<NoteDetail>(`/notes/${cur.note.id}`, {
        id: cur.note.id,
        title: cur.title.trim(),
        contentEnc:
          cur.html && cur.html !== "<p></p>" ? await encryptNote(cur.note.id, cur.html) : null,
        projectId: cur.note.project?.id ?? null,
        collectionId: cur.note.collection?.id ?? null,
        tags: cur.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        pinned: cur.note.pinned,
        favorite: cur.note.favorite,
        revision: cur.note.revision,
      });
      latest.current.note = updated;
      qc.setQueryData(["note", updated.id], updated);
      void qc.invalidateQueries({ queryKey: ["notes"] });
      setSave("saved");
    } catch (e) {
      setSave("error");
      toast.error(
        errorMessage(e),
        e instanceof ApiError && e.code === "REVISION_CONFLICT"
          ? "Reopen the note to load the latest version."
          : undefined,
      );
    }
  }, [qc]);

  const schedule = useCallback(() => {
    setSave("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 800);
  }, [flush]);

  // Save pending edits when switching away.
  useEffect(
    () => () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        void flush();
      }
    },
    [flush],
  );

  const meta = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch<NoteSummary>(`/notes/${id}`, body),
    onSuccess: (s) => {
      if (latest.current.note) latest.current.note = { ...latest.current.note, ...s };
      void qc.invalidateQueries({ queryKey: ["notes"] });
      void qc.invalidateQueries({ queryKey: ["note", id] });
    },
  });
  const trash = useMutation({
    mutationFn: () => del(`/notes/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notes"] });
      toast.success("Moved to trash");
      onGone();
    },
  });
  const restore = useMutation({
    mutationFn: () => post(`/notes/${id}/restore`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notes"] });
      void qc.invalidateQueries({ queryKey: ["note", id] });
    },
  });
  const purge = useMutation({
    mutationFn: () => del(`/notes/${id}/purge`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notes"] });
      onGone();
    },
  });

  if (isLoading || (note && html === null)) return <Skeleton className="m-6 h-64" />;
  if (error || !note)
    return (
      <p className="p-6 text-muted-foreground text-sm">
        {error ? errorMessage(error) : "Not found"}
      </p>
    );
  const n = latest.current.note ?? note;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 px-4 pt-4 md:px-8 md:pt-6">
        <div className="flex items-start gap-2">
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              latest.current.title = e.target.value;
              schedule();
            }}
            placeholder="Untitled"
            className="min-w-0 flex-1 bg-transparent font-semibold text-2xl outline-none placeholder:text-muted-foreground/50"
            disabled={!!n.deletedAt}
          />
          <span
            className={cn(
              "mt-2 shrink-0 text-xs",
              save === "error" ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {save === "saving"
              ? "Saving…"
              : save === "dirty"
                ? "Edited"
                : save === "error"
                  ? "Not saved"
                  : `Saved ${timeAgo(n.updatedAt)}`}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={n.pinned ? "Unpin" : "Pin"}
            onClick={() => meta.mutate({ pinned: !n.pinned })}
          >
            {n.pinned ? <PinOff /> : <Pin />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Favorite"
            onClick={() => meta.mutate({ favorite: !n.favorite })}
          >
            <Star className={n.favorite ? "fill-amber-400 text-amber-400" : ""} />
          </Button>
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
              <MoreHorizontal />
            </MenuTrigger>
            <MenuPopup align="end">
              {n.deletedAt ? (
                <>
                  <MenuItem onClick={() => restore.mutate()}>
                    <ArchiveRestore /> Restore
                  </MenuItem>
                  <MenuItem variant="destructive" onClick={() => purge.mutate()}>
                    <Trash2 /> Delete permanently
                  </MenuItem>
                </>
              ) : (
                <>
                  <MenuItem onClick={() => meta.mutate({ archived: !n.archived })}>
                    <Archive /> {n.archived ? "Unarchive" : "Archive"}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={() => trash.mutate()}>
                    <Trash2 /> Move to trash
                  </MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
        </div>
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <SimpleSelect
            size="sm"
            className="w-40 min-w-0"
            value={n.project?.id ?? ""}
            onChange={(v) => meta.mutate({ projectId: v || null })}
            allowEmpty
            emptyLabel="No project"
            options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
          />
          <SimpleSelect
            size="sm"
            className="w-40 min-w-0"
            value={n.collection?.id ?? ""}
            onChange={(v) => meta.mutate({ collectionId: v || null })}
            allowEmpty
            emptyLabel="No collection"
            options={(collections ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
          <Input
            size="sm"
            className="w-48"
            placeholder="Tags"
            value={tags}
            onChange={(e) => {
              setTags(e.target.value);
              latest.current.tags = e.target.value;
              schedule();
            }}
          />
          <span className="flex items-center gap-1 text-muted-foreground text-xs">
            <Lock className="size-3" /> Encrypted
          </span>
        </div>
      </div>
      <NoteEditor
        note={note}
        html={html ?? ""}
        className="min-h-0 flex-1 border-border/60 border-t"
        onChange={(h) => {
          latest.current.html = h;
          schedule();
        }}
      />
    </div>
  );
}

export function NotesPage() {
  const search = useSearch({ strict: false }) as NotesSearch;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState(search.q ?? "");
  const view = search.view ?? "all";
  const { data, isLoading } = useNotes({
    view,
    q: search.q,
    projectId: search.projectId,
    collectionId: search.collectionId,
    tag: search.tag,
  });
  const notes = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const creating = useRef(false);

  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((search.q ?? "") !== q)
        void navigate({
          to: "/notes",
          search: (s: NotesSearch) => ({ ...s, q: q || undefined }),
          replace: true,
        });
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, search.q, navigate]);

  const createNote = useCallback(async () => {
    if (creating.current) return;
    creating.current = true;
    try {
      const id = crypto.randomUUID();
      await post<NoteDetail>("/notes", {
        id,
        title: "",
        contentEnc: null,
        projectId: search.projectId ?? null,
        collectionId: search.collectionId ?? null,
      });
      await qc.invalidateQueries({ queryKey: ["notes"] });
      void navigate({
        to: "/notes",
        search: (s: NotesSearch) => ({
          ...s,
          view: s.view === "trash" || s.view === "archived" ? undefined : s.view,
          note: id,
        }),
        replace: true,
      });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      creating.current = false;
    }
  }, [navigate, qc, search.projectId, search.collectionId]);

  // The command palette's "Create note" lands here with ?note=new.
  useEffect(() => {
    if (search.note === "new") void createNote();
  }, [search.note, createNote]);

  const select = (id?: string) =>
    void navigate({ to: "/notes", search: (s: NotesSearch) => ({ ...s, note: id }) });

  return (
    <Page
      title="Notes"
      fill
      actions={
        <Button size="xs" variant="outline" onClick={() => void createNote()}>
          <Plus /> New note
        </Button>
      }
    >
      <nav className="hidden w-44 shrink-0 flex-col gap-0.5 border-border border-r p-2 lg:flex">
        {VIEWS.map((v) => (
          <button
            key={v.value}
            type="button"
            onClick={() =>
              void navigate({
                to: "/notes",
                search: { view: v.value === "all" ? undefined : v.value },
              })
            }
            className={cn(
              "flex h-8 items-center gap-2 rounded-md px-2.5 text-sm hover:bg-accent",
              view === v.value && "bg-accent font-medium",
            )}
          >
            <v.icon className="size-4 text-muted-foreground" />
            {v.label}
          </button>
        ))}
      </nav>
      <div
        className={cn(
          "flex w-full flex-col border-border border-r md:w-72 md:shrink-0",
          search.note && search.note !== "new" && "hidden md:flex",
        )}
      >
        <div className="space-y-2 border-border border-b p-3">
          <div className="relative">
            <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 text-muted-foreground/70" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search titles and tags…"
              className="ps-8"
              size="sm"
            />
          </div>
          <div className="lg:hidden">
            <SimpleSelect
              size="sm"
              value={view}
              onChange={(v) =>
                void navigate({ to: "/notes", search: { view: v as NotesSearch["view"] } })
              }
              options={VIEWS.map((v) => ({ value: v.value, label: v.label }))}
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {isLoading &&
            ["a", "b", "c", "d", "e", "f"].map((k) => (
              <Skeleton key={k} className="h-14 rounded-lg" />
            ))}
          {!isLoading && notes.length === 0 && (
            <Empty className="py-14">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <NotebookText />
                </EmptyMedia>
                <EmptyTitle>{search.q ? "No matching notes" : "No notes here"}</EmptyTitle>
                <EmptyDescription>
                  Notes are encrypted on this device. Search covers titles and tags.
                </EmptyDescription>
              </EmptyHeader>
              {view !== "trash" && (
                <Button size="sm" onClick={() => void createNote()}>
                  <Plus /> New note
                </Button>
              )}
            </Empty>
          )}
          {notes.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => select(n.id)}
              className={cn(
                "w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/60",
                search.note === n.id && "bg-accent hover:bg-accent",
              )}
            >
              <div className="flex items-center gap-1.5">
                {n.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
                <span className="truncate font-medium text-sm">{n.title || "Untitled"}</span>
                {n.favorite && <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 truncate text-muted-foreground text-xs">
                <span>{timeAgo(n.updatedAt)}</span>
                {n.project && <span>· {n.project.name}</span>}
                {n.tags.slice(0, 2).map((t) => (
                  <span key={t}>#{t}</span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div
        className={cn(
          "min-w-0 flex-1 overflow-y-auto",
          (!search.note || search.note === "new") && "hidden md:block",
        )}
      >
        {search.note && search.note !== "new" ? (
          <NoteView key={search.note} id={search.note} onGone={() => select(undefined)} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-muted-foreground text-sm">
            Select a note or create one.
          </div>
        )}
      </div>
    </Page>
  );
}
