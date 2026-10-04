import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactElement, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

export const GROUP_COLORS = [
  "#64748b",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

export function NewGroupDialog({
  kind,
  trigger,
  onCreated,
}: {
  kind: "project" | "collection";
  trigger: ReactElement;
  onCreated?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(GROUP_COLORS[6]!);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: () =>
      post<{ id: string }>(kind === "project" ? "/projects" : "/collections", {
        name,
        description: description || null,
        color,
      }),
    onSuccess: async (row) => {
      await qc.invalidateQueries({ queryKey: [kind === "project" ? "projects" : "collections"] });
      toast.success(`${kind === "project" ? "Project" : "Collection"} created`);
      setOpen(false);
      setName("");
      setDescription("");
      if (onCreated) onCreated(row.id);
      else if (kind === "project")
        void navigate({ to: "/projects/$projectId", params: { projectId: row.id } });
      else void navigate({ to: "/vault", search: { collectionId: row.id } });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogPopup className="max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>New {kind}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="group-name">Name</Label>
              <Input
                id="group-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === "project" ? "ClipMesh" : "Development"}
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="group-desc">Description</Label>
              <Textarea
                id="group-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={500}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Color</Label>
              <div className="flex gap-1.5">
                {GROUP_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Color ${c}`}
                    onClick={() => setColor(c)}
                    className={cn(
                      "size-6 rounded-full border-2 border-transparent",
                      color === c && "border-foreground/60",
                    )}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Create {kind}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
