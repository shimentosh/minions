import { CornerLeftUp, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PageIcon } from "@/components/pages/page-tree";
import { useMovePage } from "@/components/pages/pages-context";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { usePageActions, usePageTree } from "@/lib/pages/queries";
import {
  ancestorsOf,
  isWithin,
  type PageEntry,
  pageTitle,
  positionAtEnd,
  searchPages,
} from "@/lib/pages/tree";
import { toast } from "@/lib/toast";

/** Moves a page under another page, or to the top level, without dragging. */
export function MovePageDialog() {
  const pageId = useMovePage((s) => s.pageId);
  const close = () => useMovePage.setState({ pageId: null });
  const { index, visible } = usePageTree();
  const actions = usePageActions();
  const [q, setQ] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts with an empty search
  useEffect(() => setQ(""), [pageId]);

  const page = pageId ? index.byId.get(pageId) : undefined;
  const targets = useMemo(() => {
    if (!pageId) return [];
    // Not the page itself, nothing under it, and not where it already is.
    const ok = (p: PageEntry) => !isWithin(index, p.id, pageId) && p.id !== page?.parentId;
    const all = (visible ?? []).filter(ok);
    if (q.trim()) return searchPages(all, q, 30);
    return [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
  }, [pageId, page?.parentId, index, visible, q]);

  const moveTo = async (parentId: string | null) => {
    if (!pageId) return;
    close();
    try {
      await actions.move(pageId, { parentId, position: positionAtEnd(index, parentId) });
      const target = parentId ? pageTitle(index.byId.get(parentId)) : "the top level";
      toast.success(`Moved to ${target}`);
    } catch (e) {
      toast.error("Couldn't move the page", errorMessage(e));
    }
  };

  const row =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none";

  return (
    <Dialog open={!!pageId} onOpenChange={(o) => !o && close()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Move “{pageTitle(page)}”</DialogTitle>
          <DialogDescription>
            Pick the page to put it in. Its sub-pages go with it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <div className="relative">
            <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 text-muted-foreground/70" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search pages…"
              className="ps-8"
              onKeyDown={(e) => {
                if (e.key === "Enter" && targets[0]) void moveTo(targets[0].id);
              }}
            />
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {page?.parentId && !q.trim() && (
              <li>
                <button type="button" className={row} onClick={() => void moveTo(null)}>
                  <CornerLeftUp className="size-4 text-muted-foreground" />
                  Top level
                </button>
              </li>
            )}
            {targets.map((t) => {
              const path = ancestorsOf(index, t.id).map(pageTitle).join(" / ");
              return (
                <li key={t.id}>
                  <button type="button" className={row} onClick={() => void moveTo(t.id)}>
                    <PageIcon page={t} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{pageTitle(t)}</span>
                      {path && (
                        <span className="block truncate text-muted-foreground text-xs">{path}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
            {targets.length === 0 && (
              <li className={cn(row, "text-muted-foreground hover:bg-transparent")}>
                No page matches.
              </li>
            )}
          </ul>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
