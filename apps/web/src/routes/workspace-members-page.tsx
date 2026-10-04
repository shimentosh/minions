import type { MemberProfile } from "@minions/core";
import { publicKeyFingerprint, type WorkspaceMember, type WorkspaceRole } from "@minions/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronRight, Fingerprint, Globe, KeyRound, LogOut, UserPlus } from "lucide-react";
import { useState } from "react";
import { EmptyNote, Page, PageBody, Section } from "@/components/layout/page";
import { SimpleSelect } from "@/components/simple-select";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MemberAvatar } from "@/components/workspaces/member-avatar";
import { WorkspaceBanners, WorkspaceTabs } from "@/components/workspaces/workspace-shell";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { ACTION_LABELS, shortDate, timeAgo } from "@/lib/format";
import { ItemGlyph } from "@/lib/item-icons";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { confirmMember } from "@/lib/workspace-crypto";
import {
  useInvalidateWorkspaces,
  useMemberProfile,
  useWorkspace,
  useWorkspaceActivity,
  useWorkspaceMembers,
} from "@/lib/workspace-queries";

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

function useFingerprint(publicKey: string | null | undefined) {
  return useQuery({
    queryKey: ["fingerprint", publicKey],
    enabled: !!publicKey,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => publicKeyFingerprint(publicKey!),
  });
}

function StatusBadge({ m }: { m: WorkspaceMember }) {
  if (m.status === "INVITED")
    return (
      <Badge variant="outline" size="sm">
        Invited
      </Badge>
    );
  if (m.status === "ACCEPTED")
    return (
      <Badge variant="warning" size="sm">
        Needs confirmation
      </Badge>
    );
  return null;
}

/** Comparing fingerprints out of band is what makes sure the server did not swap in its own key. */
function ConfirmDialog({
  workspaceId,
  member,
  onClose,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  onClose: () => void;
}) {
  const { data: fp } = useFingerprint(member.publicKey);
  const invalidate = useInvalidateWorkspaces();
  const confirm = useMutation({
    mutationFn: () => confirmMember(workspaceId, member),
    onSuccess: () => {
      toast.success(`${member.name ?? member.email} confirmed`);
      void invalidate();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm {member.name ?? member.email}?</AlertDialogTitle>
          <AlertDialogDescription>
            Your device encrypts the workspace key to this public key. Email addresses are not
            verified, and the server could swap in another key: before confirming, call or meet{" "}
            {member.name ?? member.email} and have them read the fingerprint on their Members page.
            Confirm only if it matches exactly:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="mx-6 rounded-lg bg-muted/60 p-3 text-center font-mono text-sm tracking-wide">
          {fp ?? "…"}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button loading={confirm.isPending} onClick={() => confirm.mutate()}>
            Fingerprints match, confirm
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function RemoveDialog({
  workspaceId,
  member,
  onClose,
  onRemoved,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const invalidate = useInvalidateWorkspaces();
  const { data: profile } = useQuery({
    queryKey: ["ws", workspaceId, "member", member.id],
    enabled: member.status !== "INVITED",
    queryFn: () => get<MemberProfile>(`/workspaces/${workspaceId}/members/${member.id}`),
  });
  const remove = useMutation({
    mutationFn: () =>
      del<{ deleted: number; flagged: number }>(`/workspaces/${workspaceId}/members/${member.id}`),
    onSuccess: (r) => {
      toast.success(
        member.status === "INVITED" ? "Invitation cancelled" : "Member removed",
        r?.flagged
          ? `${r.flagged} credential${r.flagged === 1 ? "" : "s"} they could open are marked for key rotation.`
          : undefined,
      );
      void invalidate();
      onClose();
      onRemoved?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const sole = profile?.soleAccessCount ?? 0;
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {member.status === "INVITED" ? "Cancel invitation" : "Remove"}{" "}
            {member.name ?? member.email}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {member.status === "INVITED"
              ? "The invitation stops working."
              : "They lose access to every credential in this workspace at once. Anything they already saw may have been copied: change those passwords and rotate the keys afterwards."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {sole > 0 && (
          <p className="mx-6 rounded-lg border border-warning/30 bg-warning/8 p-3 text-sm">
            {sole} credential{sole === 1 ? " is" : "s are"} private to them. Nobody else holds
            {sole === 1 ? " its" : " their"} key, so {sole === 1 ? "it is" : "they are"} deleted.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate()}>
            {member.status === "INVITED" ? "Cancel invitation" : "Remove member"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function InviteForm({
  workspaceId,
  canInviteAdmins,
}: {
  workspaceId: string;
  canInviteAdmins: boolean;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"MEMBER" | "ADMIN">("MEMBER");
  const invalidate = useInvalidateWorkspaces();
  const invite = useMutation({
    mutationFn: () => post(`/workspaces/${workspaceId}/members`, { email: email.trim(), role }),
    onSuccess: () => {
      toast.success(
        "Invitation created",
        `${email.trim()} will see it after signing in to Minions with that email.`,
      );
      setEmail("");
      void invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (email.trim()) invite.mutate();
      }}
    >
      <Input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="teammate@company.com"
        className="min-w-56 flex-1"
        aria-label="Email"
      />
      {canInviteAdmins && (
        <SimpleSelect
          className="w-32"
          value={role}
          onChange={(v) => setRole(v as "MEMBER" | "ADMIN")}
          options={[
            { value: "MEMBER", label: "Member" },
            { value: "ADMIN", label: "Admin" },
          ]}
        />
      )}
      <Button type="submit" loading={invite.isPending} disabled={!email.trim()}>
        <UserPlus /> Invite
      </Button>
    </form>
  );
}

export function WorkspaceMembersPage() {
  const { workspaceId } = useParams({ strict: false }) as { workspaceId: string };
  const navigate = useNavigate();
  const me = useSession((s) => s.me);
  const { data: ws } = useWorkspace(workspaceId);
  const confirmed = ws?.status === "CONFIRMED";
  const { data: members } = useWorkspaceMembers(workspaceId, confirmed);
  const invalidate = useInvalidateWorkspaces();
  const [confirming, setConfirming] = useState<WorkspaceMember | null>(null);
  const [removing, setRemoving] = useState<WorkspaceMember | null>(null);
  const [leaving, setLeaving] = useState(false);
  const self = members?.find((m) => m.userId === me?.user.id);
  const { data: myFp } = useFingerprint(self?.publicKey);
  const isOwner = ws?.role === "OWNER";
  const isAdmin = isOwner || ws?.role === "ADMIN";

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) =>
      patch(`/workspaces/${workspaceId}/members/${id}`, { role }),
    onSuccess: () => void invalidate(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const leave = useMutation({
    mutationFn: () => post(`/workspaces/${workspaceId}/leave`),
    onSuccess: () => {
      toast.success(`You left ${ws?.name}`);
      void invalidate();
      void navigate({ to: "/workspaces" });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Page
      title="Members"
      crumbs={[
        { label: "Workspaces", to: "/workspaces" },
        { label: ws?.name ?? "Workspace", to: `/w/${workspaceId}` },
      ]}
      actions={<WorkspaceTabs workspaceId={workspaceId} />}
      className="flex flex-col"
    >
      {ws && <WorkspaceBanners ws={ws} />}
      <PageBody
        title={`${ws?.name ?? ""} members`}
        subtitle="Membership alone shows nothing: people see only credentials shared with them or with everyone."
        actions={
          ws && !isOwner ? (
            <Button variant="outline" size="sm" onClick={() => setLeaving(true)}>
              <LogOut /> Leave
            </Button>
          ) : null
        }
      >
        {isAdmin && (
          <Section
            title="Invite"
            hint="Invitations wait in Minions for the person who signs in with that email."
          >
            <InviteForm workspaceId={workspaceId} canInviteAdmins={isOwner} />
          </Section>
        )}
        <Section title="People">
          {!confirmed && <EmptyNote>Visible once an admin confirms you.</EmptyNote>}
          <div className="divide-y divide-border/60">
            {members?.map((m) => {
              const isSelf = m.userId === me?.user.id;
              return (
                <div key={m.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <MemberAvatar name={m.name ?? m.email} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm">
                      {m.status !== "INVITED" ? (
                        <Link
                          to="/w/$workspaceId/members/$memberId"
                          params={{ workspaceId, memberId: m.id }}
                          className="truncate font-medium hover:underline"
                        >
                          {m.name ?? m.email}
                        </Link>
                      ) : (
                        <span className="truncate font-medium">{m.email}</span>
                      )}
                      {isSelf && <span className="text-muted-foreground text-xs">(you)</span>}
                      <StatusBadge m={m} />
                    </div>
                    <div className="truncate text-muted-foreground text-xs">
                      {m.email} ·{" "}
                      {m.status === "CONFIRMED" && m.confirmedAt
                        ? `joined ${shortDate(m.confirmedAt)}`
                        : `invited ${timeAgo(m.invitedAt)}`}
                    </div>
                  </div>
                  {isOwner && m.role !== "OWNER" && m.status !== "INVITED" ? (
                    <SimpleSelect
                      size="sm"
                      className="w-28"
                      value={m.role}
                      onChange={(role) => changeRole.mutate({ id: m.id, role })}
                      options={[
                        { value: "MEMBER", label: "Member" },
                        { value: "ADMIN", label: "Admin" },
                      ]}
                    />
                  ) : (
                    <Badge variant="outline" size="sm">
                      {ROLE_LABEL[m.role]}
                    </Badge>
                  )}
                  {isAdmin && m.status === "ACCEPTED" && (
                    <Button size="sm" onClick={() => setConfirming(m)}>
                      Confirm
                    </Button>
                  )}
                  {isAdmin && !isSelf && m.role !== "OWNER" && (isOwner || m.role === "MEMBER") && (
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>
                      {m.status === "INVITED" ? "Cancel" : "Remove"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
        {myFp && (
          <Section
            title="Your key fingerprint"
            hint="Read this to an admin who confirms you, so they know the key is really yours."
          >
            <div className="flex items-center gap-2 font-mono text-sm">
              <Fingerprint className="size-4 text-muted-foreground" /> {myFp}
            </div>
          </Section>
        )}
      </PageBody>
      {confirming && (
        <ConfirmDialog
          workspaceId={workspaceId}
          member={confirming}
          onClose={() => setConfirming(null)}
        />
      )}
      {removing && (
        <RemoveDialog
          workspaceId={workspaceId}
          member={removing}
          onClose={() => setRemoving(null)}
        />
      )}
      <AlertDialog open={leaving} onOpenChange={setLeaving}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {ws?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              You lose access to its credentials. Credentials only you can open are deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" loading={leave.isPending} onClick={() => leave.mutate()}>
              Leave workspace
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Page>
  );
}

export function WorkspaceMemberPage() {
  const { workspaceId, memberId } = useParams({ strict: false }) as {
    workspaceId: string;
    memberId: string;
  };
  const navigate = useNavigate();
  const me = useSession((s) => s.me);
  const { data: ws } = useWorkspace(workspaceId);
  const { data: profile, error } = useMemberProfile(workspaceId, memberId);
  const { data: fp } = useFingerprint(profile?.member.publicKey);
  const isAdmin = ws?.role === "OWNER" || ws?.role === "ADMIN";
  const m = profile?.member;
  const { data: activity } = useWorkspaceActivity(
    workspaceId,
    isAdmin && m?.userId ? { userId: m.userId } : { userId: me?.user.id },
  );
  const [removing, setRemoving] = useState(false);
  const canRemove =
    isAdmin &&
    m &&
    m.userId !== me?.user.id &&
    m.role !== "OWNER" &&
    (ws?.role === "OWNER" || m.role === "MEMBER");
  const showActivity = isAdmin || m?.userId === me?.user.id;

  return (
    <Page
      title={m?.name ?? m?.email ?? "Member"}
      crumbs={[
        { label: "Workspaces", to: "/workspaces" },
        { label: ws?.name ?? "Workspace", to: `/w/${workspaceId}` },
        { label: "Members", to: `/w/${workspaceId}/members` },
      ]}
      actions={<WorkspaceTabs workspaceId={workspaceId} />}
    >
      <PageBody>
        {error && <p className="text-muted-foreground text-sm">{errorMessage(error)}</p>}
        {m && (
          <div className="flex flex-wrap items-center gap-3">
            <MemberAvatar name={m.name ?? m.email} className="size-12 text-sm" />
            <div className="min-w-0 flex-1">
              <h1 className="font-semibold text-xl">{m.name ?? m.email}</h1>
              <p className="text-muted-foreground text-sm">
                {m.email} · {ROLE_LABEL[m.role]}
                {m.confirmedAt ? ` · member since ${shortDate(m.confirmedAt)}` : ""}
              </p>
              {fp && (
                <p className="mt-1 flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
                  <Fingerprint className="size-3.5" /> {fp}
                </p>
              )}
            </div>
            {canRemove && (
              <Button variant="outline" onClick={() => setRemoving(true)}>
                Remove from workspace
              </Button>
            )}
          </div>
        )}
        {profile && (
          <Section
            title={`Password access · ${profile.credentials.length}`}
            hint="Credentials this member can open, among those you can open too. Access only; no passwords are shown here."
          >
            {profile.credentials.length === 0 && (
              <EmptyNote>Nothing shared with them that you can see.</EmptyNote>
            )}
            <div className="divide-y divide-border/60">
              {profile.credentials.map((c) => (
                <Link
                  key={c.id}
                  to="/w/$workspaceId"
                  params={{ workspaceId }}
                  search={{ item: c.id }}
                  className="flex items-center gap-3 py-2 hover:bg-accent/40"
                >
                  <ItemGlyph type={c.type} className="size-7 [&_svg]:size-3.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{c.name}</span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {c.subtitle ?? c.host ?? ""}
                    </span>
                  </span>
                  {c.via === "workspace" ? (
                    <Badge variant="outline" size="sm">
                      <Globe className="size-3" /> Everyone
                    </Badge>
                  ) : (
                    <Badge variant="outline" size="sm">
                      <KeyRound className="size-3" /> Shared directly
                    </Badge>
                  )}
                  <Badge variant={c.permission === "MANAGE" ? "secondary" : "outline"} size="sm">
                    {c.permission === "MANAGE" ? "Can manage" : "Can use"}
                  </Badge>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </Link>
              ))}
            </div>
          </Section>
        )}
        {showActivity && m?.userId && (
          <Section title="Recent activity in this workspace">
            {(activity?.pages[0]?.items.length ?? 0) === 0 && <EmptyNote>Nothing yet.</EmptyNote>}
            {activity?.pages[0]?.items.slice(0, 15).map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  {ACTION_LABELS[a.action] ?? a.action}
                  {a.itemName && <span className="text-muted-foreground"> · {a.itemName}</span>}
                </span>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {a.device ? `${a.device} · ` : ""}
                  {timeAgo(a.createdAt)}
                </span>
              </div>
            ))}
          </Section>
        )}
      </PageBody>
      {removing && m && (
        <RemoveDialog
          workspaceId={workspaceId}
          member={m}
          onClose={() => setRemoving(false)}
          onRemoved={() =>
            void navigate({ to: "/w/$workspaceId/members", params: { workspaceId } })
          }
        />
      )}
    </Page>
  );
}
