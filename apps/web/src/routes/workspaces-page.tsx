import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Mail, Plus, Users } from "lucide-react";
import { useState } from "react";
import { EmptyNote, Page, PageBody, Section } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, post } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { createWorkspace } from "@/lib/workspace-crypto";
import { useInvalidateWorkspaces, useInvitations, useWorkspaces } from "@/lib/workspace-queries";

const ROLE_LABEL = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member" } as const;

export function WorkspacesPage() {
  const { data: workspaces, isLoading } = useWorkspaces();
  const { data: invitations } = useInvitations();
  const invalidate = useInvalidateWorkspaces();
  const navigate = useNavigate();
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => createWorkspace(name.trim()),
    onSuccess: (id) => {
      setName("");
      void invalidate();
      void navigate({ to: "/w/$workspaceId", params: { workspaceId: id } });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const respond = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "accept" | "decline" }) =>
      post<{ workspaceId?: string }>(`/workspaces/invitations/${id}/${action}`),
    onSuccess: (_r, v) => {
      toast.success(
        v.action === "accept" ? "Joined" : "Invitation declined",
        v.action === "accept"
          ? "An owner or admin confirms you next; then shared credentials appear."
          : undefined,
      );
      void invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Page title="Workspaces">
      <PageBody
        title="Team workspaces"
        subtitle="Share specific credentials with specific people. Everything stays end-to-end encrypted: each credential's key is sealed to each person on your device."
      >
        {(invitations?.length ?? 0) > 0 && (
          <Section
            title="Invitations"
            hint="Joining shares your public key with the workspace admins."
          >
            {invitations!.map((inv) => (
              <div key={inv.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
                <Mail className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{inv.workspaceName}</div>
                  <div className="text-muted-foreground text-xs">
                    {inv.invitedBy ? `${inv.invitedBy} invited you` : "You were invited"} as{" "}
                    {ROLE_LABEL[inv.role].toLowerCase()} · {timeAgo(inv.createdAt)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => respond.mutate({ id: inv.id, action: "decline" })}
                >
                  Decline
                </Button>
                <Button size="sm" onClick={() => respond.mutate({ id: inv.id, action: "accept" })}>
                  Join
                </Button>
              </div>
            ))}
          </Section>
        )}

        <Section title="Your workspaces">
          {isLoading && <EmptyNote>Loading…</EmptyNote>}
          {!isLoading && !workspaces?.length && (
            <EmptyNote>No workspaces yet. Create one below and invite your team.</EmptyNote>
          )}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces?.map((w) => (
              <Link
                key={w.id}
                to="/w/$workspaceId"
                params={{ workspaceId: w.id }}
                className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/60"
              >
                <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                  <Users className="size-4 text-muted-foreground" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sm">{w.name}</span>
                  <span className="block text-muted-foreground text-xs">
                    {w.memberCount} member{w.memberCount === 1 ? "" : "s"}
                  </span>
                </span>
                {w.status === "CONFIRMED" ? (
                  <Badge variant="outline" size="sm">
                    {ROLE_LABEL[w.role]}
                  </Badge>
                ) : (
                  <Badge variant="warning" size="sm">
                    Awaiting confirmation
                  </Badge>
                )}
              </Link>
            ))}
          </div>
        </Section>

        <Section title="New workspace" hint="You become its owner.">
          <form
            className="flex max-w-md gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme agency"
              maxLength={80}
              aria-label="Workspace name"
            />
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              <Plus /> Create
            </Button>
          </form>
        </Section>
      </PageBody>
    </Page>
  );
}
