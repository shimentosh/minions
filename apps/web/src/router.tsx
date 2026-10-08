import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { LockScreen, SignInScreen, Splash } from "@/components/auth/auth-screens";
import { CommandPalette } from "@/components/command-palette";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { VerifyEmailBanner } from "@/components/layout/verify-email-banner";
import { QuickCaptureDialog } from "@/components/quick-capture";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ItemEditorDialog } from "@/components/vault/item-editor";
import { MoveDialog, OrganizeDnd } from "@/components/vault/organize";
import { useAutoLock } from "@/lib/auto-lock";
import { restoreDesktopSession } from "@/lib/desktop";
import { useSession } from "@/lib/session";
import { usePendingSeals } from "@/lib/use-pending-seals";
import { ActivityPage } from "@/routes/activity-page";
import { AuthenticatorPage } from "@/routes/authenticator-page";
import { CleanupPage } from "@/routes/cleanup-page";
import { DashboardPage } from "@/routes/dashboard-page";
import { DevicesPage } from "@/routes/devices-page";
import { GeneratorPage } from "@/routes/generator-page";
import type { NotesSearch } from "@/routes/notes-page";
import { OperatorPage } from "@/routes/operator-page";
import { ProjectPage, ProjectsPage } from "@/routes/projects-page";
import { PublicSharePage } from "@/routes/public-share-page";
import { SecurityPage } from "@/routes/security-page";
import { SharedPage, type SharedSearch } from "@/routes/shared-page";
import { SharesPage } from "@/routes/shares-page";
import { VaultPage, type VaultSearch } from "@/routes/vault-page";
import { VerifyEmailPage } from "@/routes/verify-email-page";
import { WorkspaceActivityPage } from "@/routes/workspace-activity-page";
import { WorkspaceMemberPage, WorkspaceMembersPage } from "@/routes/workspace-members-page";
import { WorkspacePage, type WorkspaceSearch } from "@/routes/workspace-page";
import { WorkspacesPage } from "@/routes/workspaces-page";

// Heavier screens (rich-text editor, import parsers, QR codes) load on first visit.
const NotesPage = lazyRouteComponent(() => import("@/routes/notes-page"), "NotesPage");
const ImportPage = lazyRouteComponent(() => import("@/routes/import-page"), "ImportPage");
const SettingsPage = lazyRouteComponent(() => import("@/routes/settings-page"), "SettingsPage");

function readSidebarDefault() {
  try {
    return localStorage.getItem("minions-sidebar") !== "false";
  } catch {
    return true;
  }
}

/** The signed-in, unlocked app: the reference's sidebar-inset shell. */
function AppShell() {
  useAutoLock();
  usePendingSeals();
  return (
    <div className="app-height flex w-full overflow-hidden bg-background md:h-auto md:overflow-visible">
      <SidebarProvider
        className="min-h-0 md:min-h-svh"
        defaultOpen={readSidebarDefault()}
        style={{ "--sidebar-width": "calc(var(--spacing) * 60)" } as React.CSSProperties}
      >
        <OrganizeDnd>
          <AppSidebar />
          <SidebarInset className="flex min-h-0 flex-1 flex-col overflow-auto md:m-2 md:h-[calc(100svh-1rem)] md:rounded-xl md:border md:border-border/80 md:shadow-sm/5">
            <VerifyEmailBanner />
            <Outlet />
          </SidebarInset>
        </OrganizeDnd>
        <MoveDialog />
        <CommandPalette />
        <QuickCaptureDialog />
        <ItemEditorDialog />
      </SidebarProvider>
    </div>
  );
}

function Gate() {
  const status = useSession((s) => s.status);
  const refresh = useSession((s) => s.refresh);
  useEffect(() => {
    void restoreDesktopSession()
      .then(refresh)
      .catch(() => useSession.setState({ status: "signed-out" }));
  }, [refresh]);

  if (status === "loading") return <Splash />;
  if (status === "signed-out" || status === "two-factor") return <SignInScreen />;
  if (status === "locked") return <LockScreen />;
  return <AppShell />;
}

const rootRoute = createRootRoute({
  component: () => (
    <ToastProvider position="bottom-right">
      <TooltipProvider delay={400}>
        <div className="app-height flex w-full flex-row overflow-hidden bg-background">
          {/* A share link needs no account: it never goes through the sign-in gate. */}
          {window.location.pathname.startsWith("/s/") ? (
            <PublicSharePage />
          ) : window.location.pathname === "/verify-email" ? (
            <VerifyEmailPage />
          ) : (
            <Gate />
          )}
        </div>
      </TooltipProvider>
    </ToastProvider>
  ),
});

/** Renders only once unlocked, so the sign-in screen still reads /login or /register. */
function ToVault() {
  return <Navigate to="/vault" replace />;
}

const bool = (v: unknown) => (v === true || v === "true" ? true : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const routes = [
  // The vault is the start page.
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: ToVault }),
  createRoute({ getParentRoute: () => rootRoute, path: "/reports", component: DashboardPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/vault",
    component: VaultPage,
    validateSearch: (s: Record<string, unknown>): VaultSearch => ({
      q: str(s.q),
      category: str(s.category) as VaultSearch["category"],
      projectId: str(s.projectId),
      collectionId: str(s.collectionId),
      tag: str(s.tag),
      favorite: bool(s.favorite),
      trash: bool(s.trash),
      sort: str(s.sort) as VaultSearch["sort"],
      item: str(s.item),
    }),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/notes",
    component: NotesPage,
    validateSearch: (s: Record<string, unknown>): NotesSearch => ({
      view: str(s.view) as NotesSearch["view"],
      q: str(s.q),
      projectId: str(s.projectId),
      collectionId: str(s.collectionId),
      tag: str(s.tag),
      note: str(s.note),
    }),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/projects", component: ProjectsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId",
    component: ProjectPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/security", component: SecurityPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/authenticator",
    component: AuthenticatorPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/shares", component: SharesPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/shared",
    component: SharedPage,
    validateSearch: (s: Record<string, unknown>): SharedSearch => ({
      side: s.side === "by-me" ? "by-me" : undefined,
      item: str(s.item),
    }),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/s/$shareId", component: PublicSharePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/verify-email",
    component: VerifyEmailPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/activity", component: ActivityPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/devices", component: DevicesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/generator", component: GeneratorPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/import", component: ImportPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/cleanup", component: CleanupPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: SettingsPage,
    validateSearch: (s: Record<string, unknown>): { tab?: "security" | "data" } => ({
      tab: s.tab === "security" || s.tab === "data" ? s.tab : undefined,
    }),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: WorkspacesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/operator", component: OperatorPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/w/$workspaceId",
    component: WorkspacePage,
    validateSearch: (s: Record<string, unknown>): WorkspaceSearch => ({
      q: str(s.q),
      show: str(s.show) as WorkspaceSearch["show"],
      folderId: str(s.folderId),
      tag: str(s.tag),
      item: str(s.item),
    }),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/w/$workspaceId/members",
    component: WorkspaceMembersPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/w/$workspaceId/members/$memberId",
    component: WorkspaceMemberPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/w/$workspaceId/activity",
    component: WorkspaceActivityPage,
  }),
  // Sign-in and sign-up render from the gate; the paths only pick the tab.
  createRoute({ getParentRoute: () => rootRoute, path: "/login", component: ToVault }),
  createRoute({ getParentRoute: () => rootRoute, path: "/register", component: ToVault }),
];

export const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
