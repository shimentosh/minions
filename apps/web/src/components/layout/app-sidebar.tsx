import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  ChevronRight,
  Cloud,
  CreditCard,
  FolderKanban,
  Globe,
  KeyRound,
  Layers,
  LayoutDashboard,
  Link2,
  Lock,
  type LucideIcon,
  MonitorSmartphone,
  NotebookText,
  Plus,
  SearchIcon,
  ShieldCheck,
  Sparkles,
  Star,
  Timer,
  Trash2,
  Upload,
  Users,
  Vault,
  WandSparkles,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/cn";
import { useCollections, useProjects, useSecurity } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useUi } from "@/lib/ui-store";
import { useInvitations, useWorkspaces } from "@/lib/workspace-queries";
import { useOperatorStatus } from "@/routes/operator-page";
import { NewGroupDialog } from "./new-group-dialog";

interface NavItem {
  title: string;
  icon: LucideIcon;
  to: string;
  search?: Record<string, string | boolean | undefined>;
  badge?: number | null;
  /** Active when the current location matches. */
  match: (path: string, search: Record<string, unknown>) => boolean;
}

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
            render={
              <SidebarGroupLabel className="h-7 cursor-pointer justify-between px-0 text-sidebar-accent-foreground" />
            }
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
                    className={cn(
                      "gap-2.5 ps-3 text-sm hover:bg-transparent hover:text-sidebar-accent-foreground active:bg-transparent [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-foreground/60 data-[active=true]:[&>svg]:text-sidebar-accent-foreground",
                      isMobile ? "h-11" : "h-8",
                    )}
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

const vaultMatch =
  (key: string, value?: string | boolean) => (path: string, s: Record<string, unknown>) =>
    path === "/vault" &&
    (value === undefined
      ? !s.category && !s.favorite && !s.trash && !s.projectId && !s.collectionId && !s.tag
      : s[key] === value);

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

export function AppSidebar() {
  const { data: projects } = useProjects();
  const { data: collections } = useCollections();
  const { data: security } = useSecurity();
  const setCapture = useUi((s) => s.setCapture);
  const { data: workspaces } = useWorkspaces();
  const { data: invitations } = useInvitations();
  const { data: operator } = useOperatorStatus();
  const openIssues =
    security?.findings.filter((f) => !f.dismissed && f.severity !== "low").length ?? null;

  const vault: NavItem[] = [
    { title: "Home", icon: LayoutDashboard, to: "/", match: (p) => p === "/" },
    { title: "All items", icon: Vault, to: "/vault", search: {}, match: vaultMatch("") },
    {
      title: "Favorites",
      icon: Star,
      to: "/vault",
      search: { favorite: true },
      match: vaultMatch("favorite", true),
    },
    {
      title: "Logins",
      icon: Globe,
      to: "/vault",
      search: { category: "login" },
      match: vaultMatch("category", "login"),
    },
    {
      title: "Secrets & keys",
      icon: KeyRound,
      to: "/vault",
      search: { category: "secret" },
      match: vaultMatch("category", "secret"),
    },
    {
      title: "Infrastructure",
      icon: Cloud,
      to: "/vault",
      search: { category: "infrastructure" },
      match: vaultMatch("category", "infrastructure"),
    },
    {
      title: "Financial",
      icon: CreditCard,
      to: "/vault",
      search: { category: "financial" },
      match: vaultMatch("category", "financial"),
    },
    {
      title: "Authenticator",
      icon: Timer,
      to: "/authenticator",
      match: (p) => p === "/authenticator",
    },
    { title: "Notes", icon: NotebookText, to: "/notes", match: (p) => p.startsWith("/notes") },
    {
      title: "Trash",
      icon: Trash2,
      to: "/vault",
      search: { trash: true },
      match: vaultMatch("trash", true),
    },
  ];

  const projectItems: NavItem[] = (projects ?? [])
    .filter((p) => !p.archived)
    .map((p) => ({
      title: p.name,
      icon: FolderKanban,
      to: `/projects/${p.id}`,
      badge: p.itemCount || null,
      match: (path) => path === `/projects/${p.id}`,
    }));
  projectItems.push({
    title: "All projects",
    icon: Layers,
    to: "/projects",
    match: (p) => p === "/projects",
  });

  const collectionItems: NavItem[] = (collections ?? []).map((c) => ({
    title: c.name,
    icon: Layers,
    to: "/vault",
    search: { collectionId: c.id },
    badge: c.itemCount || null,
    match: (p, s) => p === "/vault" && s.collectionId === c.id,
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

  const securityItems: NavItem[] = [
    {
      title: "Security Center",
      icon: ShieldCheck,
      to: "/security",
      badge: openIssues,
      match: (p) => p === "/security",
    },
    { title: "Shared links", icon: Link2, to: "/shares", match: (p) => p === "/shares" },
    { title: "Activity", icon: Activity, to: "/activity", match: (p) => p === "/activity" },
    {
      title: "Devices & sessions",
      icon: MonitorSmartphone,
      to: "/devices",
      match: (p) => p === "/devices",
    },
  ];

  const tools: NavItem[] = [
    {
      title: "Password generator",
      icon: WandSparkles,
      to: "/generator",
      match: (p) => p === "/generator",
    },
    { title: "Import", icon: Upload, to: "/import", match: (p) => p === "/import" },
    { title: "Cleanup", icon: Wrench, to: "/cleanup", match: (p) => p === "/cleanup" },
  ];
  // Shown only to accounts on the server's OPERATOR_USER_IDS allowlist.
  if (operator?.operator)
    tools.push({
      title: "Operator",
      icon: Activity,
      to: "/operator",
      match: (p) => p === "/operator",
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
        <NavGroup label="Vault" items={vault} />
        <NavGroup label="Workspaces" items={workspaceItems} />
        <NavGroup label="Projects" items={projectItems} action={addButton("project")} />
        <NavGroup label="Collections" items={collectionItems} action={addButton("collection")} />
        <NavGroup label="Security" items={securityItems} />
        <NavGroup label="Tools" items={tools} />
      </SidebarContent>
      <SidebarFooter>
        <button
          type="button"
          onClick={() => setCapture(true)}
          className="flex h-9 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-background/60 px-3 text-sm text-sidebar-accent-foreground shadow-xs hover:bg-background"
        >
          <Sparkles className="size-4 text-sidebar-foreground/70" />
          Quick capture
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}
