import { resolveField } from "@minions/core";
import { useParams } from "@tanstack/react-router";
import { EmptyNote, Page, PageBody, Section } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { MemberAvatar } from "@/components/workspaces/member-avatar";
import { WorkspaceTabs } from "@/components/workspaces/workspace-shell";
import { ACTION_LABELS, timeAgo } from "@/lib/format";
import { useWorkspace, useWorkspaceActivity } from "@/lib/workspace-queries";

/** The workspace audit log: who created, shared, opened, copied or filled what. Never a value. */
export function WorkspaceActivityPage() {
  const { workspaceId } = useParams({ strict: false }) as { workspaceId: string };
  const { data: ws } = useWorkspace(workspaceId);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useWorkspaceActivity(workspaceId);
  const rows = data?.pages.flatMap((p) => p.items) ?? [];
  const admin = ws?.role === "OWNER" || ws?.role === "ADMIN";

  return (
    <Page
      title="Activity"
      crumbs={[
        { label: "Workspaces", to: "/workspaces" },
        { label: ws?.name ?? "Workspace", to: `/w/${workspaceId}` },
      ]}
      actions={<WorkspaceTabs workspaceId={workspaceId} />}
    >
      <PageBody
        title="Audit log"
        subtitle={
          admin
            ? "Everything that happened in this workspace. Passwords are never recorded."
            : "Your own actions in this workspace. Owners and admins see everyone's."
        }
      >
        <Section title="Events">
          {isLoading && <EmptyNote>Loading…</EmptyNote>}
          {!isLoading && rows.length === 0 && <EmptyNote>Nothing yet.</EmptyNote>}
          <div className="divide-y divide-border/60">
            {rows.map((a) => {
              const field =
                typeof a.metadata?.field === "string" ? (a.metadata.field as string) : null;
              const member =
                typeof a.metadata?.member === "string" ? (a.metadata.member as string) : null;
              return (
                <div key={a.id} className="flex items-center gap-3 py-2 text-sm">
                  <MemberAvatar name={a.actor?.name ?? "?"} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      <span className="font-medium">{a.actor?.name ?? "Someone"}</span>{" "}
                      <span className="text-muted-foreground">
                        {(ACTION_LABELS[a.action] ?? a.action).toLowerCase()}
                      </span>
                      {a.itemName && <span> {a.itemName}</span>}
                      {field && (
                        <span className="text-muted-foreground">
                          {" "}
                          · {resolveField(a.itemType ?? "LOGIN", field)?.def.label ?? field}
                        </span>
                      )}
                      {member && <span className="text-muted-foreground"> · {member}</span>}
                    </div>
                    <div className="truncate text-muted-foreground text-xs">{a.actor?.email}</div>
                  </div>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {a.device ? `${a.device} · ` : ""}
                    {timeAgo(a.createdAt)}
                  </span>
                </div>
              );
            })}
          </div>
          {hasNextPage && (
            <Button
              variant="ghost"
              size="sm"
              loading={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              Load more
            </Button>
          )}
        </Section>
      </PageBody>
    </Page>
  );
}
