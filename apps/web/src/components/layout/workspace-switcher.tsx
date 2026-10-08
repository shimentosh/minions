import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Plus, Settings2 } from "lucide-react";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { useInvitations, useWorkspaces } from "@/lib/workspace-queries";

const COLORS = ["#3b82f6", "#22c55e", "#8b5cf6", "#f97316", "#ec4899", "#14b8a6", "#eab308"];

/** A workspace's square: its first letter on a colour picked from its id. */
function WorkspaceMark({ id, name, className }: { id: string; name: string; className?: string }) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg font-semibold text-sm text-white",
        className,
      )}
      style={{ background: COLORS[h % COLORS.length] }}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || "W"}
    </span>
  );
}

function PersonalMark({ className }: { className?: string }) {
  return <img src="/minions.svg" alt="" className={cn("size-7 shrink-0 rounded-lg", className)} />;
}

/**
 * The top of the sidebar: which vault you are in. Switches between the
 * personal vault and each team workspace, like a team switcher.
 */
export function WorkspaceSwitcher() {
  const me = useSession((s) => s.me);
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { data: workspaces } = useWorkspaces();
  const { data: invitations } = useInvitations();
  const currentId = path.match(/^\/w\/([^/]+)/)?.[1];
  const current = workspaces?.find((w) => w.id === currentId);
  const pending = invitations?.length ?? 0;

  return (
    <Menu>
      <MenuTrigger
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/40 data-popup-open:bg-sidebar-accent"
        aria-label="Switch workspace"
      >
        {current ? <WorkspaceMark id={current.id} name={current.name} /> : <PersonalMark />}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-sidebar-accent-foreground text-sm">
            {current ? current.name : "Personal vault"}
          </span>
          <span className="block truncate text-[11px] text-sidebar-foreground">
            {current
              ? `${current.memberCount} member${current.memberCount === 1 ? "" : "s"}`
              : me?.user.email}
          </span>
        </span>
        {pending > 0 && (
          <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-primary font-medium text-[10px] text-primary-foreground">
            {pending}
          </span>
        )}
        <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/70" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-64">
        <MenuGroup>
          <MenuGroupLabel>Personal</MenuGroupLabel>
          <MenuItem onClick={() => void navigate({ to: "/vault" })}>
            <PersonalMark className="size-5 rounded-md" />
            <span className="min-w-0 flex-1 truncate">Personal vault</span>
            {!current && <Check className="size-4" />}
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Team workspaces</MenuGroupLabel>
          {workspaces?.map((w) => (
            <MenuItem
              key={w.id}
              onClick={() =>
                void navigate({ to: "/w/$workspaceId", params: { workspaceId: w.id } })
              }
            >
              <WorkspaceMark id={w.id} name={w.name} className="size-5 rounded-md text-[11px]" />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              {w.status !== "CONFIRMED" && (
                <span className="text-muted-foreground text-xs">pending</span>
              )}
              {current?.id === w.id && <Check className="size-4" />}
            </MenuItem>
          ))}
          {!workspaces?.length && (
            <p className="px-2 py-1.5 text-muted-foreground text-xs">
              Share credentials with your team.
            </p>
          )}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/workspaces" })}>
          <Plus /> New workspace
        </MenuItem>
        <MenuItem onClick={() => void navigate({ to: "/workspaces" })}>
          <Settings2 />
          <span className="flex-1">Manage workspaces</span>
          {pending > 0 && (
            <span className="text-muted-foreground text-xs">
              {pending} invitation{pending === 1 ? "" : "s"}
            </span>
          )}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
