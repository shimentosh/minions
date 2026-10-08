import { useDndMonitor } from "@dnd-kit/core";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ChevronRight,
  FolderKanban,
  Layers,
  Lock,
  type LucideIcon,
  Plus,
  SearchIcon,
  Users,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { type MoveTarget, useDropTarget } from "@/components/vault/organize";
import { cn } from "@/lib/cn";
import { useCollections, useProjects, useSecurity } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useUi } from "@/lib/ui-store";
import { useInvitations, useWorkspaces } from "@/lib/workspace-queries";
import { useSharedWithMe } from "@/routes/shared-page";
import { HUBS, hubFor } from "./hubs";
import { NewGroupDialog } from "./new-group-dialog";

interface NavItem {
  title: string;
  icon: LucideIcon;
  to: string;
  search?: Record<string, string | boolean | undefined>;
  badge?: number | null;
  color?: string | null;
  /** Active when the current location matches. */
  match: (path: string, search: Record<string, unknown>) => boolean;
}

const MAX_ROWS = 6;
const NAV_BUTTON =
  "gap-2.5 ps-3 text-sm hover:bg-transparent hover:text-sidebar-accent-foreground active:bg-transparent [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-foreground/60 data-[active=true]:[&>svg]:text-sidebar-accent-foreground";
const GROUP_LABEL = "h-7 cursor-pointer justify-between px-0 text-sidebar-accent-foreground";

// The reference's NavGroup: a collapsible label, 32px rows, muted icons that
// brighten when active.
function NavGroup({
  label,
  items,
  action,
}: {
  label: string;
  items: NavItem[];
  action?: ReactNode;
}) {
  const { isMobile } = useSidebar();
  const location = useRouterState({ select: (s) => s.location });
  const search = location.search as Record<string, unknown>;

  return (
    <Collapsible defaultOpen className="group/collapsible">
      <SidebarGroup className="gap-1 p-2">
        <div className="flex items-center">
          <CollapsibleTrigger
            className="flex-1 data-panel-open:[&_svg]:rotate-90"
            render={<SidebarGroupLabel className={GROUP_LABEL} />}
          >
            <span>{label}</span>
            <ChevronRight className="h-3.5 w-3.5 text-sidebar-foreground/60 transition-transform duration-200" />
          </CollapsibleTrigger>
          {action}
        </div>
        <CollapsiblePanel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {items.map((item) => (
                <SidebarMenuItem key={`${item.to}-${item.title}`}>
                  <SidebarMenuButton
                    tooltip={item.title}
                    isActive={item.match(location.pathname, search)}
                    className={cn(NAV_BUTTON, isMobile ? "h-11" : "h-8")}
                    render={<Link to={item.to} search={item.search as never} />}
                  >
                    <item.icon aria-hidden />
                    <span className="truncate">{item.title}</span>
                    {item.badge ? (
                      <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-sm border border-sidebar-border/60 px-1 font-medium text-[11px] text-sidebar-foreground/80">
                        {item.badge}
                      </span>
                    ) : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsiblePanel>
      </SidebarGroup>
    </Collapsible>
  );
}

function VaultHeader() {
  const me = useSession((s) => s.me);
  const lock = useSession((s) => s.lock);
  return (
    <div className="flex w-full items-center gap-2 px-1.5">
      <Link to="/" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1">
        <img src="/minions.svg" alt="" className="size-7 rounded-lg" />
        <span className="min-w-0">
          <span className="block truncate font-semibold text-sm text-sidebar-accent-foreground">
            Minions
          </span>
          <span className="block truncate text-[11px] text-sidebar-foreground">
            {me?.user.email}
          </span>
        </span>
      </Link>
      <button
        type="button"
        onClick={() => void lock()}
        title="Lock vault"
        className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Lock className="size-4" />
        <span className="sr-only">Lock vault</span>
      </button>
    </div>
  );
}

function SearchButton() {
  const setPalette = useUi((s) => s.setPalette);
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  return (
    <SidebarGroup className="pb-1">
      <button
        className="inline-flex h-8 w-full cursor-pointer rounded-md border border-input bg-background px-2 py-1.5 text-foreground text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={() => setPalette(true)}
        type="button"
      >
        <span className="flex grow items-center">
          <SearchIcon
            aria-hidden="true"
            className="-ms-1 me-3 text-muted-foreground/80"
            size={16}
          />
          <span className="font-normal text-muted-foreground/70">Search vault…</span>
        </span>
        <kbd className="-me-0.5 ms-6 inline-flex h-4 max-h-full items-center rounded border border-border/70 bg-background px-1 font-[inherit] font-medium text-[0.625rem] text-muted-foreground/60">
          {mac ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>
    </SidebarGroup>
  );
}

/** A sidebar project or collection: a link, and a place to drop dragged items. */
function DropNavItem({ item, target }: { item: NavItem; target: MoveTarget }) {
  const { isMobile } = useSidebar();
  const location = useRouterState({ select: (s) => s.location });
  const drop = useDropTarget(target);
  return (
    <SidebarMenuItem ref={drop.setNodeRef}>
      <SidebarMenuButton
        tooltip={item.title}
        isActive={item.match(location.pathname, location.search as Record<string, unknown>)}
        className={cn(
          NAV_BUTTON,
          isMobile ? "h-11" : "h-8",
          drop.dragging && "ring-1 ring-sidebar-border ring-inset",
          drop.isOver && "bg-primary/10 text-sidebar-accent-foreground ring-primary/50",
        )}
        render={<Link to={item.to} search={item.search as never} />}
      >
        {item.color ? (
          <span className="flex size-4 items-center justify-center">
            <span className="size-2 rounded-full" style={{ background: item.color }} />
          </span>
        ) : (
          <item.icon aria-hidden />
        )}
        <span className="truncate">{item.title}</span>
        {item.badge ? <Badge>{item.badge}</Badge> : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Shown only mid-drag: drop here to take items out of their project or collection. */
function RemoveTarget({ kind }: { kind: "project" | "collection" }) {
  const drop = useDropTarget({ kind, id: null, name: `its ${kind}` });
  return (
    <SidebarMenuItem ref={drop.setNodeRef} className={cn(!drop.dragging && "hidden")}>
      <div
        className={cn(
          "flex h-8 items-center gap-2 rounded-md border border-sidebar-border border-dashed ps-3 text-sidebar-foreground/70 text-xs",
          drop.isOver && "border-primary/60 bg-primary/10 text-sidebar-accent-foreground",
        )}
      >
        <X className="size-3.5" /> No {kind}
      </div>
    </SidebarMenuItem>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-sm border border-sidebar-border/60 px-1 font-medium text-[11px] text-sidebar-foreground/80">
      {children}
    </span>
  );
}

/** Whether a sidebar group is expanded. Closed unless the person opened it; remembered. */
function useGroupOpen(kind: string) {
  const key = `minions-sidebar-${kind}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) === "open";
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(key, v ? "open" : "closed");
    } catch {
      // Private mode: lasts for this visit only.
    }
  };
  return [open, set] as const;
}

/** A collapsible list of projects or collections that accept drops, trimmed to a few rows. */
function DropGroup({
  label,
  kind,
  items,
  more,
  action,
  empty,
}: {
  label: string;
  kind: "project" | "collection";
  items: (NavItem & { id: string })[];
  more?: NavItem;
  action: ReactNode;
  empty: string;
}) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useGroupOpen(kind);
  // Opens while an item is being dragged, so its projects or collections can take the drop.
  const [dragging, setDragging] = useState(false);
  useDndMonitor({
    onDragStart: () => setDragging(true),
    onDragEnd: () => setDragging(false),
    onDragCancel: () => setDragging(false),
  });
  const shown = all ? items : items.slice(0, MAX_ROWS);
  return (
    <Collapsible open={open || dragging} onOpenChange={setOpen} className="group/collapsible">
      <SidebarGroup className="gap-1 p-2">
        <div className="flex items-center">
          <CollapsibleTrigger
            className="flex-1 data-panel-open:[&_svg]:rotate-90"
            render={<SidebarGroupLabel className={GROUP_LABEL} />}
          >
            <span>{label}</span>
            <ChevronRight className="h-3.5 w-3.5 text-sidebar-foreground/60 transition-transform duration-200" />
          </CollapsibleTrigger>
          {action}
        </div>
        <CollapsiblePanel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {shown.map((item) => (
                <DropNavItem
                  key={item.id}
                  item={item}
                  target={{ kind, id: item.id, name: item.title }}
                />
              ))}
              {!items.length && (
                <li className="px-3 py-1 text-sidebar-foreground/60 text-xs">{empty}</li>
              )}
              {items.length > MAX_ROWS && (
                <SidebarMenuItem>
                  <button
                    type="button"
                    onClick={() => setAll(!all)}
                    className="h-7 w-full rounded-md ps-3 text-left text-sidebar-foreground/70 text-xs hover:text-sidebar-accent-foreground"
                  >
                    {all ? "Show less" : `Show all ${items.length}`}
                  </button>
                </SidebarMenuItem>
              )}
              {more && <PlainNavItem item={more} />}
              <RemoveTarget kind={kind} />
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsiblePanel>
      </SidebarGroup>
    </Collapsible>
  );
}

function PlainNavItem({ item }: { item: NavItem }) {
  const { isMobile } = useSidebar();
  const location = useRouterState({ select: (s) => s.location });
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={item.title}
        isActive={item.match(location.pathname, location.search as Record<string, unknown>)}
        className={cn(NAV_BUTTON, isMobile ? "h-11" : "h-8")}
        render={<Link to={item.to} search={item.search as never} />}
      >
        <item.icon aria-hidden />
        <span className="truncate">{item.title}</span>
        {item.badge ? <Badge>{item.badge}</Badge> : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const { data: projects } = useProjects();
  const { data: collections } = useCollections();
  const { data: security } = useSecurity();
  const { data: workspaces } = useWorkspaces();
  const { data: invitations } = useInvitations();
  const { data: sharedWithMe } = useSharedWithMe();
  const newShared = sharedWithMe?.filter((i) => i.isNew && i.status === "active").length ?? null;
  const location = useRouterState({ select: (s) => s.location });
  const activeHub = hubFor(location.pathname, location.search as Record<string, unknown>);
  const openIssues =
    security?.findings.filter((f) => !f.dismissed && f.severity !== "low").length ?? null;

  const hubs: NavItem[] = HUBS.map((h) => ({
    title: h.title,
    icon: h.icon,
    to: h.to,
    badge: h.id === "security" ? openIssues : h.id === "shared" ? newShared : null,
    match: () => activeHub?.id === h.id,
  }));

  const projectItems = (projects ?? [])
    .filter((p) => !p.archived)
    .map((p) => ({
      id: p.id,
      title: p.name,
      icon: FolderKanban,
      color: p.color,
      to: `/projects/${p.id}`,
      badge: p.itemCount || null,
      match: (path: string) => path === `/projects/${p.id}`,
    }));

  const collectionItems = (collections ?? []).map((c) => ({
    id: c.id,
    title: c.name,
    icon: Layers,
    color: c.color,
    to: "/vault",
    search: { collectionId: c.id },
    badge: c.itemCount || null,
    match: (p: string, s: Record<string, unknown>) => p === "/vault" && s.collectionId === c.id,
  }));

  const workspaceItems: NavItem[] = (workspaces ?? []).map((w) => ({
    title: w.name,
    icon: Users,
    to: `/w/${w.id}`,
    match: (p) => p === `/w/${w.id}` || p.startsWith(`/w/${w.id}/`),
  }));
  workspaceItems.push({
    title: workspaceItems.length ? "All workspaces" : "Team workspaces",
    icon: Layers,
    to: "/workspaces",
    badge: invitations?.length || null,
    match: (p) => p === "/workspaces",
  });

  const addButton = (kind: "project" | "collection") => (
    <NewGroupDialog
      kind={kind}
      trigger={
        <button
          type="button"
          title={`New ${kind}`}
          className="flex size-6 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Plus className="size-3.5" />
          <span className="sr-only">New {kind}</span>
        </button>
      }
    />
  );

  return (
    <Sidebar collapsible="offcanvas" variant="inset" className="border-none pt-1.5">
      <SidebarHeader className="pt-1 pb-1.5">
        <VaultHeader />
      </SidebarHeader>
      <SidebarContent className="gap-1 py-1">
        <SearchButton />
        <SidebarGroup className="p-2 pt-0">
          <SidebarMenu className="gap-0.5">
            {hubs.map((item) => (
              <PlainNavItem key={item.title} item={item} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <div className="mx-4 my-1 h-px bg-sidebar-border/70" />
        <DropGroup
          label="Projects"
          kind="project"
          items={projectItems}
          more={{
            title: "All projects",
            icon: Layers,
            to: "/projects",
            match: (p) => p === "/projects",
          }}
          action={addButton("project")}
          empty="Group credentials by product or client."
        />
        <DropGroup
          label="Collections"
          kind="collection"
          items={collectionItems}
          action={addButton("collection")}
          empty="Folders for anything else."
        />
        <NavGroup label="Workspaces" items={workspaceItems} />
      </SidebarContent>
    </Sidebar>
  );
}
