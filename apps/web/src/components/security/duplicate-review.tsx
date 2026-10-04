import type { SecurityFinding } from "@minions/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
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
import { errorMessage, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ItemGlyph } from "@/lib/item-icons";
import { useInvalidateVault } from "@/lib/queries";
import { toast } from "@/lib/toast";

/**
 * Merge, link or keep separate. Nothing happens without an explicit choice,
 * and a merge only moves the others to the trash (restorable); it never
 * copies or overwrites secret values.
 */
export function DuplicateReview({
  finding,
  open,
  onOpenChange,
}: {
  finding: SecurityFinding;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [target, setTarget] = useState(finding.items[0]!.id);
  const invalidate = useInvalidateVault();
  const others = finding.items.filter((i) => i.id !== target).map((i) => i.id);
  const done = (msg: string) => {
    toast.success(msg);
    onOpenChange(false);
    void invalidate();
  };

  const merge = useMutation({
    mutationFn: () => post(`/vault/items/${target}/merge`, { sourceIds: others }),
    onSuccess: () => done("Merged. The others are in the trash."),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const link = useMutation({
    mutationFn: async () => {
      for (const id of others)
        await post("/relations", { fromItemId: target, toItemId: id, kind: "RELATED" });
      await post("/security/findings/state", { key: finding.key, status: "keep_separate" });
    },
    onSuccess: () => done("Linked"),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const keep = useMutation({
    mutationFn: () =>
      post("/security/findings/state", { key: finding.key, status: "keep_separate" }),
    onSuccess: () => done("Kept separate"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Possible duplicates</DialogTitle>
          <DialogDescription>
            {finding.detail} Choose the one to keep as the source of truth.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-1.5">
          {finding.items.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => setTarget(i.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left",
                target === i.id ? "border-primary bg-accent" : "hover:bg-accent/50",
              )}
            >
              <ItemGlyph type={i.type} className="size-7 [&_svg]:size-3.5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{i.name}</span>
                <span className="block truncate text-muted-foreground text-xs">{i.subtitle}</span>
              </span>
              {target === i.id && <span className="text-xs">Keep</span>}
            </button>
          ))}
          <p className="pt-1 text-muted-foreground text-xs">
            Merge moves the others to the trash and points their links at the one you keep. Copy
            anything you need from them first; nothing is overwritten.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => keep.mutate()} loading={keep.isPending}>
            Keep separate
          </Button>
          <Button variant="outline" onClick={() => link.mutate()} loading={link.isPending}>
            Link
          </Button>
          <Button onClick={() => merge.mutate()} loading={merge.isPending}>
            Merge
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
