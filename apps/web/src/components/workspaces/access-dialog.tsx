import type { ItemAccessResponse, WorkspaceItemDetail } from "@minions/core";
import { useMutation } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage, put } from "@/lib/api";
import { itemKeyFor } from "@/lib/item-keys";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { buildAccess } from "@/lib/workspace-crypto";
import {
  useInvalidateWorkspaces,
  useItemAccess,
  useWorkspaceMembers,
} from "@/lib/workspace-queries";
import { type AccessDraft, AccessEditor, draftGrants } from "./new-item-access";

function draftFrom(access: ItemAccessResponse, selfId: string): AccessDraft {
  const others = access.grants.filter((g) => g.userId !== selfId);
  return {
    mode: access.workspaceShared ? "everyone" : others.length ? "members" : "private",
    members: Object.fromEntries(others.map((g) => [g.userId, g.permission])),
  };
}

/**
 * Who can open one credential. Adding someone seals the item key to their
 * public key on this device; removing someone stops the server serving it to
 * them at once, but they may have kept what they saw, so the item is flagged
 * for re-keying and the password should be changed at the service.
 */
export function AccessDialog({
  item,
  open,
  onOpenChange,
}: {
  item: WorkspaceItemDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ws = item.workspaceId;
  const selfId = useSession((s) => s.me?.user.id)!;
  const { data: access } = useItemAccess(ws, item.id, open);
  const { data: members } = useWorkspaceMembers(ws, open);
  const invalidate = useInvalidateWorkspaces();
  const [draft, setDraft] = useState<AccessDraft | null>(null);

  useEffect(() => {
    if (access && !draft) setDraft(draftFrom(access, selfId));
  }, [access, draft, selfId]);

  const removed = useMemo(() => {
    if (!access || !draft) return [];
    const keep = new Set(
      draft.mode === "private" ? [selfId] : [selfId, ...Object.keys(draft.members)],
    );
    return access.grants.filter((g) => !keep.has(g.userId));
  }, [access, draft, selfId]);
  const losesEveryone = !!access?.workspaceShared && draft?.mode !== "everyone";

  const save = useMutation({
    mutationFn: async () => {
      const itemKey = itemKeyFor(item.id);
      if (!itemKey || !draft || !members || !access) throw new Error("Open the credential again.");
      const body = await buildAccess({
        workspaceId: ws,
        itemId: item.id,
        itemKey,
        workspaceShared: draft.mode === "everyone",
        grants: draftGrants(draft, members, selfId),
        existing: new Set(access.grants.map((g) => g.userId)),
      });
      // Already shared with everyone: the wrapped key on the server stays as it is.
      if (access.workspaceShared && draft.mode === "everyone") delete body.workspaceWrappedKey;
      await put(`/workspaces/${ws}/items/${item.id}/access`, body);
    },
    onSuccess: () => {
      toast.success("Access updated");
      void invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Manage access · {item.name}</DialogTitle>
          <DialogDescription>
            The key to this credential is encrypted separately for each person on your device. The
            server never sees it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {draft ? (
            <AccessEditor workspaceId={ws} value={draft} onChange={setDraft} />
          ) : (
            <p className="py-6 text-center text-muted-foreground text-sm">Loading…</p>
          )}
          {(removed.length > 0 || losesEveryone) && (
            <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/8 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
              <p>
                {losesEveryone
                  ? "Members who lose access"
                  : `${removed.map((r) => r.name).join(", ")}`}{" "}
                will be cut off immediately, but may have copied the password. Change it at the
                service, then rotate this credential's key.
              </p>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!draft} onClick={() => save.mutate()}>
            Save access
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
