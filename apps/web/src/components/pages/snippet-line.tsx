import { cn } from "@/lib/cn";
import type { Snippet } from "@/lib/pages/search";

/** Where the search words were found in a page, with the match highlighted. */
export function SnippetLine({ snippet, className }: { snippet: Snippet; className?: string }) {
  return (
    <span className={cn("block truncate text-muted-foreground text-xs", className)}>
      {snippet.before}
      <mark className="rounded-sm bg-amber-300/40 px-0.5 text-foreground">{snippet.match}</mark>
      {snippet.after}
    </span>
  );
}
