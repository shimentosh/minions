import type {
  ItemPermission,
  UpsertItemRequest,
  WorkspaceItemSummary,
  WorkspaceMember,
} from "@minions/core";
import { Globe, Lock, Users } from "lucide-react";
import { SimpleSelect } from "@/components/simple-select";
import { Label } from "@/components/ui/label";
import { get, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { itemKeyFor } from "@/lib/item-keys";
import { requireSharingKeys, useSession } from "@/lib/session";
import { buildAccess, type DesiredGrant } from "@/lib/workspace-crypto";
import { useWorkspaceMembers } from "@/lib/workspace-queries";
import { MemberAvatar } from "./member-avatar";

export type AccessMode = "private" | "members" | "everyone";

export interface AccessDraft {
  mode: AccessMode;
  /** Explicit grants for other members, by user id. */
  members: Record<string, ItemPermission>;
}

const MODES: { value: AccessMode; label: string; hint: string; icon: typeof Lock }[] = [
  { value: "private", label: "Only me", hint: "Nobody else can open it", icon: Lock },
  { value: "members", label: "Specific members", hint: "Pick who can use it", icon: Users },
  {
    value: "everyone",
    label: "Everyone in the workspace",
    hint: "All confirmed members can use it",
    icon: Globe,
  },
];

/** Members who can receive a grant: confirmed, with a sharing key, not the current user. */
export function shareableMembers(
  members: WorkspaceMember[] | undefined,
  selfId: string | undefined,
) {
  return (members ?? []).filter(
    (m) => m.status === "CONFIRMED" && m.userId && m.publicKey && m.userId !== selfId,
  );
}

export function AccessEditor({
  workspaceId,
  value,
  onChange,
  disabled,
}: {
  workspaceId: string;
  value: AccessDraft;
  onChange: (next: AccessDraft) => void;
  disabled?: boolean;
}) {
  const selfId = useSession((s) => s.me?.user.id);
  const { data: members } = useWorkspaceMembers(workspaceId);
  const others = shareableMembers(members, selfId);

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Who can open it" className="grid gap-1.5 sm:grid-cols-3">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={value.mode === m.value}
            disabled={disabled}
            onClick={() => onChange({ ...value, mode: m.value })}
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
              value.mode === m.value
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-accent/60",
            )}
          >
            <span className="flex items-center gap-1.5 font-medium text-sm">
              <m.icon className="size-3.5 text-muted-foreground" aria-hidden /> {m.label}
            </span>
            <span className="text-muted-foreground text-xs">{m.hint}</span>
          </button>
        ))}
      </div>
      {value.mode !== "private" && (
        <div className="rounded-lg border">
          {others.length === 0 && (
            <p className="px-3 py-3 text-muted-foreground text-xs">
              No other confirmed members yet. Invite people from the Members page.
            </p>
          )}
          {others.map((m) => {
            const current = value.members[m.userId!];
            const options = [
              {
                value: "none",
                label: value.mode === "everyone" ? "Can use (everyone)" : "No access",
              },
              { value: "VIEW", label: "Can use" },
              { value: "MANAGE", label: "Can manage" },
            ];
            return (
              <div
                key={m.id}
                className="flex items-center gap-2 border-border/60 border-b px-3 py-2 last:border-b-0"
              >
                <MemberAvatar name={m.name ?? m.email} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{m.name ?? m.email}</div>
                  <div className="truncate text-muted-foreground text-xs">
                    {m.email} · {m.role.toLowerCase()}
                  </div>
                </div>
                <SimpleSelect
                  size="sm"
                  className="w-40"
                  value={current ?? "none"}
                  onChange={(v) => {
                    const next = { ...value.members };
                    if (v === "VIEW" || v === "MANAGE") next[m.userId!] = v;
                    else delete next[m.userId!];
                    onChange({ ...value, members: next });
                  }}
                  options={options}
                />
              </div>
            );
          })}
        </div>
      )}
      {value.mode === "everyone" && (
        <p className="text-muted-foreground text-xs">
          Owners and admins can manage credentials shared with everyone.
        </p>
      )}
    </div>
  );
}

export function NewItemAccess(props: {
  workspaceId: string;
  value: AccessDraft;
  onChange: (next: AccessDraft) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <Label>Who can open it</Label>
      <AccessEditor {...props} />
    </div>
  );
}

/** The grants a draft asks for, the caller included as a manager. */
export function draftGrants(draft: AccessDraft, members: WorkspaceMember[], selfId: string) {
  const { publicKey } = requireSharingKeys();
  const grants: DesiredGrant[] = [{ userId: selfId, publicKey, permission: "MANAGE" }];
  if (draft.mode === "private") return grants;
  for (const m of shareableMembers(members, selfId)) {
    const p = draft.members[m.userId!];
    if (p) grants.push({ userId: m.userId!, publicKey: m.publicKey!, permission: p });
  }
  return grants;
}

/** Encrypted fields plus the item key sealed to each person who should open it. */
export async function saveNewWorkspaceItem(
  workspaceId: string,
  item: UpsertItemRequest,
  draft: AccessDraft,
): Promise<WorkspaceItemSummary> {
  const itemKey = itemKeyFor(item.id);
  if (!itemKey) throw new Error("Missing item key");
  const { userId } = requireSharingKeys();
  const members = await get<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  const access = await buildAccess({
    workspaceId,
    itemId: item.id,
    itemKey,
    workspaceShared: draft.mode === "everyone",
    grants: draftGrants(draft, members, userId),
  });
  return post<WorkspaceItemSummary>(`/workspaces/${workspaceId}/items`, { item, access });
}
