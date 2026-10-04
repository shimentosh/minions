import { cn } from "@/lib/cn";

/** Initials in a circle; no images, so nothing is fetched about anyone. */
export function MemberAvatar({ name, className }: { name: string; className?: string }) {
  const initials =
    name
      .replace(/@.*/, "")
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join("") || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-[11px] text-muted-foreground",
        className,
      )}
    >
      {initials}
    </span>
  );
}
