import type { WorkspaceDetail } from "@minions/core";
import { useMutation } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Hourglass, RefreshCw, ShieldAlert, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { rekeyWorkspace } from "@/lib/workspace-crypto";
import { useInvalidateWorkspaces } from "@/lib/workspace-queries";

export function WorkspaceTabs({ workspaceId }: { workspaceId: string }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const tabs = [
    { label: "Credentials", to: `/w/${workspaceId}`, active: path === `/w/${workspaceId}` },
    {
      label: "Members",
      to: `/w/${workspaceId}/members`,
      active: path.startsWith(`/w/${workspaceId}/members`),
    },
    {
      label: "Activity",
      to: `/w/${workspaceId}/activity`,
      active: path === `/w/${workspaceId}/activity`,
    },
  ];
  return (
    <nav className="flex items-center gap-0.5" aria-label="Workspace">
      {tabs.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          className={cn(
            "rounded-md px-2 py-1 text-xs transition-colors",
            t.active
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** What needs attention in this workspace, above its content. */
export function WorkspaceBanners({ ws }: { ws: WorkspaceDetail }) {
  const invalidate = useInvalidateWorkspaces();
  const rekey = useMutation({
    mutationFn: () => rekeyWorkspace(ws.id),
    onSuccess: () => {
      toast.success("Workspace key rotated", "Every member now holds the new key.");
      void invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (ws.status !== "CONFIRMED")
    return (
      <Banner icon={Hourglass}>
        You joined {ws.name}. An owner or admin needs to confirm you before you can see shared
        credentials; confirming hands your device the workspace key.
      </Banner>
    );
  return (
    <>
      {ws.pendingConfirmations > 0 && (
        <Banner
          icon={UserCheck}
          action={
            <Button
              size="xs"
              variant="outline"
              render={<Link to="/w/$workspaceId/members" params={{ workspaceId: ws.id }} />}
            >
              Review
            </Button>
          }
        >
          {ws.pendingConfirmations} member{ws.pendingConfirmations === 1 ? "" : "s"} waiting for
          confirmation.
        </Banner>
      )}
      {ws.rekeyNeeded && (
        <Banner
          icon={ShieldAlert}
          tone="warning"
          action={
            <Button
              size="xs"
              variant="outline"
              loading={rekey.isPending}
              onClick={() => rekey.mutate()}
            >
              <RefreshCw /> Rotate workspace key
            </Button>
          }
        >
          A member who held the workspace key left. Rotate it so their copy no longer opens
          credentials shared with everyone.
        </Banner>
      )}
      {ws.itemsNeedingRekey > 0 && (
        <Banner icon={ShieldAlert} tone="warning">
          {ws.itemsNeedingRekey} credential{ws.itemsNeedingRekey === 1 ? "" : "s"} you manage{" "}
          {ws.itemsNeedingRekey === 1 ? "was" : "were"} open to someone who lost access. Open each
          one (marked with ⚠) to rotate its key.
        </Banner>
      )}
    </>
  );
}

function Banner({
  icon: Icon,
  children,
  action,
  tone,
}: {
  icon: typeof Hourglass;
  children: React.ReactNode;
  action?: React.ReactNode;
  tone?: "warning";
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-border border-b px-4 py-2 text-sm",
        tone === "warning" ? "bg-warning/8" : "bg-muted/40",
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          tone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
        )}
      />
      <p className="min-w-0 flex-1">{children}</p>
      {action}
    </div>
  );
}
