import { Link, useRouterState } from "@tanstack/react-router";
import {
  ChartColumn,
  FolderKanban,
  type LucideIcon,
  Settings,
  ShieldCheck,
  Users,
  Vault,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useOperatorStatus } from "@/routes/operator-page";

type Search = Record<string, unknown>;

export interface HubTab {
  label: string;
  to: string;
  search?: Record<string, string | boolean | undefined>;
  match: (path: string, s: Search) => boolean;
  /** Shown only when this returns true (e.g. operator-only tabs). */
  operatorOnly?: boolean;
}

export interface Hub {
  id: "vault" | "shared" | "projects" | "reports" | "security" | "settings";
  title: string;
  icon: LucideIcon;
  to: string;
  tabs: HubTab[];
}

const vaultTab =
  (key?: "category" | "favorite" | "trash", value?: string | boolean) =>
  (path: string, s: Search) =>
    path === "/vault" &&
    (key === undefined ? !s.category && !s.favorite && !s.trash : s[key] === value);

const at = (route: string) => (path: string) => path === route;

/**
 * The places in the app. Every screen belongs to one hub; screens of the
 * same hub are tabs of one another, so the sidebar stays short.
 */
export const HUBS: Hub[] = [
  {
    id: "vault",
    title: "Vault",
    icon: Vault,
    to: "/vault",
    tabs: [
      { label: "All", to: "/vault", search: {}, match: vaultTab() },
      {
        label: "Favorites",
        to: "/vault",
        search: { favorite: true },
        match: vaultTab("favorite", true),
      },
      {
        label: "Logins",
        to: "/vault",
        search: { category: "login" },
        match: vaultTab("category", "login"),
      },
      {
        label: "Secrets & keys",
        to: "/vault",
        search: { category: "secret" },
        match: vaultTab("category", "secret"),
      },
      {
        label: "Infrastructure",
        to: "/vault",
        search: { category: "infrastructure" },
        match: vaultTab("category", "infrastructure"),
      },
      {
        label: "Financial",
        to: "/vault",
        search: { category: "financial" },
        match: vaultTab("category", "financial"),
      },
      { label: "Authenticator", to: "/authenticator", match: at("/authenticator") },
      { label: "Notes", to: "/notes", match: (p) => p.startsWith("/notes") },
      { label: "Trash", to: "/vault", search: { trash: true }, match: vaultTab("trash", true) },
    ],
  },
  {
    id: "shared",
    title: "Shared",
    icon: Users,
    to: "/shared",
    tabs: [
      {
        label: "Shared with me",
        to: "/shared",
        search: {},
        match: (p, s) => p === "/shared" && s.side !== "by-me",
      },
      {
        label: "Shared by me",
        to: "/shared",
        search: { side: "by-me" },
        match: (p, s) => p === "/shared" && s.side === "by-me",
      },
    ],
  },
  {
    id: "projects",
    title: "Projects",
    icon: FolderKanban,
    to: "/projects",
    tabs: [{ label: "Projects", to: "/projects", match: (p) => p.startsWith("/projects") }],
  },
  {
    id: "reports",
    title: "Reports",
    icon: ChartColumn,
    to: "/reports",
    tabs: [{ label: "Reports", to: "/reports", match: at("/reports") }],
  },
  {
    id: "security",
    title: "Security",
    icon: ShieldCheck,
    to: "/security",
    tabs: [
      { label: "Health", to: "/security", match: at("/security") },
      { label: "Cleanup", to: "/cleanup", match: at("/cleanup") },
      { label: "Shared links", to: "/shares", match: at("/shares") },
      { label: "Activity", to: "/activity", match: at("/activity") },
      { label: "Devices", to: "/devices", match: at("/devices") },
    ],
  },
  {
    id: "settings",
    title: "Settings",
    icon: Settings,
    to: "/settings",
    tabs: [
      {
        label: "Account",
        to: "/settings",
        search: {},
        match: (p, s) => p === "/settings" && !s.tab,
      },
      {
        label: "Sign-in & keys",
        to: "/settings",
        search: { tab: "security" },
        match: (p, s) => p === "/settings" && s.tab === "security",
      },
      {
        label: "Backup & recovery",
        to: "/settings",
        search: { tab: "data" },
        match: (p, s) => p === "/settings" && s.tab === "data",
      },
      { label: "Import", to: "/import", match: at("/import") },
      { label: "Generator", to: "/generator", match: at("/generator") },
      { label: "Operator", to: "/operator", match: at("/operator"), operatorOnly: true },
    ],
  },
];

/** The hub the current screen belongs to. Collections and tags live in the vault. */
export function hubFor(path: string, search: Search): Hub | undefined {
  for (const hub of HUBS) if (hub.tabs.some((t) => t.match(path, search))) return hub;
  if (path === "/vault" || path === "/") return HUBS[0];
  return undefined;
}

/** The hub's tabs under the page header. Hidden for single-screen hubs. */
export function HubTabs() {
  const location = useRouterState({ select: (s) => s.location });
  const search = location.search as Search;
  const { data: operator } = useOperatorStatus();
  const hub = hubFor(location.pathname, search);
  if (!hub || hub.tabs.length < 2) return null;
  const tabs = hub.tabs.filter((t) => !t.operatorOnly || operator?.operator);
  return (
    <nav
      aria-label={hub.title}
      className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-border border-b bg-card px-3 py-1.5"
    >
      {tabs.map((t) => {
        const active = t.match(location.pathname, search);
        // Vault tabs keep the project and collection filters.
        const keep =
          t.to === "/vault"
            ? { projectId: search.projectId, collectionId: search.collectionId, ...t.search }
            : t.search;
        return (
          <Link
            key={`${t.to}-${t.label}`}
            to={t.to}
            search={keep as never}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1 text-[13px] transition-colors",
              active
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
