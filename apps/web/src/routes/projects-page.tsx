import type { ItemCategory } from "@minions/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Archive, FolderKanban, MoreHorizontal, NotebookText, Plus, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { NewGroupDialog } from "@/components/layout/new-group-dialog";
import { EmptyNote, Page, PageBody, Section } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ItemRow } from "@/components/vault/item-row";
import { BulkBar } from "@/components/vault/organize";
import { del, errorMessage, get, patch } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useItems, useProjects } from "@/lib/queries";
import { toast } from "@/lib/toast";
import { useUi } from "@/lib/ui-store";

export function ProjectsPage() {
  const { data, isLoading } = useProjects();
  const active = data?.filter((p) => !p.archived) ?? [];
  const archived = data?.filter((p) => p.archived) ?? [];
  const newButton = (
    <NewGroupDialog
      kind="project"
      trigger={
        <Button size="sm">
          <Plus /> New project
        </Button>
      }
    />
  );
  return (
    <Page title="Projects">
      <PageBody
        title="Projects"
        subtitle="Everything a project depends on: accounts, APIs, servers, environments and notes."
        actions={newButton}
      >
        {isLoading && <Skeleton className="h-32 rounded-xl" />}
        {!isLoading && active.length === 0 && (
          <Empty className="rounded-xl border py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderKanban />
              </EmptyMedia>
              <EmptyTitle>No projects yet</EmptyTitle>
              <EmptyDescription>
                Create one per product or client. A credential can belong to one project and be used
                by several.
              </EmptyDescription>
            </EmptyHeader>
            {newButton}
          </Empty>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((p) => (
            <Link
              key={p.id}
              to="/projects/$projectId"
              params={{ projectId: p.id }}
              className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/40"
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="flex size-8 items-center justify-center rounded-lg"
                  style={{ background: `${p.color ?? "#64748b"}22`, color: p.color ?? undefined }}
                >
                  <FolderKanban className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
              </div>
              {p.description && (
                <p className="line-clamp-2 text-muted-foreground text-sm">{p.description}</p>
              )}
              <div className="mt-auto flex gap-3 text-muted-foreground text-xs">
                <span>{p.itemCount} items</span>
                <span>{p.noteCount} notes</span>
              </div>
            </Link>
          ))}
        </div>
        {archived.length > 0 && (
          <Section title="Archived">
            {archived.map((p) => (
              <Link
                key={p.id}
                to="/projects/$projectId"
                params={{ projectId: p.id }}
                className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm hover:bg-accent/60"
              >
                <Archive className="size-4 text-muted-foreground" /> {p.name}
              </Link>
            ))}
          </Section>
        )}
      </PageBody>
    </Page>
  );
}

interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  archived: boolean;
  items: {
    id: string;
    name: string;
    type: string;
    subtitle: string | null;
    environment: string | null;
    shared: boolean;
    category: ItemCategory;
  }[];
  notes: { id: string; title: string; updatedAt: string }[];
}

// How a project page groups its items, in the order the spec reads them.
const GROUPS: { title: string; match: (i: ProjectDetail["items"][number]) => boolean }[] = [
  { title: "Accounts", match: (i) => i.type === "LOGIN" || i.type === "PAYMENT_ACCOUNT" },
  { title: "APIs", match: (i) => i.type === "API_KEY" || i.type === "WEBHOOK" },
  { title: "Infrastructure", match: (i) => i.category === "infrastructure" },
  {
    title: "Secrets & environments",
    match: (i) => ["SECRET", "ENVIRONMENT", "TOTP", "RECOVERY_CODE"].includes(i.type),
  },
  { title: "Other", match: () => true },
];

export function ProjectPage() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const openEditor = useUi((s) => s.openEditor);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const {
    data: project,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => get<ProjectDetail>(`/projects/${projectId}`),
  });

  // Full summaries (project and collection chips, favorites) for the shared rows.
  const summaries = useItems({ projectId });
  useEffect(() => {
    if (summaries.hasNextPage && !summaries.isFetchingNextPage) void summaries.fetchNextPage();
  }, [summaries]);
  const full = new Map(
    (summaries.data?.pages.flatMap((pg) => pg.items) ?? []).map((i) => [i.id, i]),
  );

  const archive = useMutation({
    mutationFn: () => patch(`/projects/${projectId}`, { archived: !project?.archived }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project", projectId] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/projects/${projectId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Project deleted", "Its items were kept.");
      void navigate({ to: "/projects" });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isLoading) return <Page title="Project">{<Skeleton className="m-6 h-40" />}</Page>;
  if (error || !project)
    return (
      <Page title="Project">
        {<p className="p-6 text-sm">{error ? errorMessage(error) : "Not found"}</p>}
      </Page>
    );

  const rows = project.items.flatMap((i) => full.get(i.id) ?? []);
  const remaining = [...project.items];
  const grouped = GROUPS.map((g) => {
    const items = remaining.filter(g.match);
    for (const i of items) remaining.splice(remaining.indexOf(i), 1);
    return { ...g, items };
  }).filter((g) => g.items.length > 0);

  return (
    <Page
      title={project.name}
      crumbs={[{ label: "Projects", to: "/projects" }]}
      className="relative"
    >
      <PageBody
        title={
          <span className="flex items-center gap-2">
            {project.name}
            {project.archived && <Badge variant="secondary">Archived</Badge>}
          </span>
        }
        subtitle={project.description ?? undefined}
        actions={
          <>
            <Button size="sm" onClick={() => openEditor({ projectId })}>
              <Plus /> Add item
            </Button>
            <Menu>
              <MenuTrigger
                render={<Button variant="outline" size="icon-sm" aria-label="Project actions" />}
              >
                <MoreHorizontal />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => archive.mutate()}>
                  <Archive /> {project.archived ? "Unarchive" : "Archive"}
                </MenuItem>
                <MenuItem variant="destructive" onClick={() => remove.mutate()}>
                  <Trash2 /> Delete project (keep items)
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        }
      >
        {grouped.length === 0 && (
          <EmptyNote>
            Nothing in this project yet. Add the accounts, keys and servers it uses.
          </EmptyNote>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {grouped.map((g) => (
            <Section
              key={g.title}
              title={g.title}
              hint={`${g.items.length} item${g.items.length === 1 ? "" : "s"}`}
            >
              {g.items.map((i) => {
                const item = full.get(i.id);
                return item ? (
                  <ItemRow
                    key={i.id}
                    item={item}
                    list={rows}
                    active={false}
                    onOpen={() => void navigate({ to: "/vault", search: { item: i.id } })}
                  />
                ) : (
                  <Skeleton key={i.id} className="h-14 rounded-lg" />
                );
              })}
            </Section>
          ))}
          <Section
            title="Notes"
            action={
              <Link
                to="/notes"
                search={{ projectId }}
                className="text-muted-foreground text-xs hover:text-foreground"
              >
                All
              </Link>
            }
          >
            {project.notes.length === 0 ? (
              <EmptyNote>No notes for this project.</EmptyNote>
            ) : (
              project.notes.map((n) => (
                <Link
                  key={n.id}
                  to="/notes"
                  search={{ note: n.id }}
                  className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-accent/60"
                >
                  <NotebookText className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{n.title || "Untitled"}</span>
                  <span className="text-muted-foreground text-xs">{timeAgo(n.updatedAt)}</span>
                </Link>
              ))
            )}
          </Section>
        </div>
      </PageBody>
      <BulkBar items={rows} />
    </Page>
  );
}
