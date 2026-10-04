import { Link } from "@tanstack/react-router";
import { ChevronRight, Lock, Plus, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { useUi } from "@/lib/ui-store";
import { UserMenu } from "./user-menu";

/** Shared header actions, top-right on every page, as in the reference's HeaderActions. */
function HeaderActions() {
  const lock = useSession((s) => s.lock);
  const setCapture = useUi((s) => s.setCapture);
  const openEditor = useUi((s) => s.openEditor);
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 self-center">
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-sm" onClick={() => setCapture(true)} />}
        >
          <Sparkles className="h-4 w-4" />
          <span className="sr-only">Quick capture</span>
        </TooltipTrigger>
        <TooltipPopup>Quick capture</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-sm" onClick={() => void lock()} />}
        >
          <Lock className="h-4 w-4" />
          <span className="sr-only">Lock vault</span>
        </TooltipTrigger>
        <TooltipPopup>Lock vault</TooltipPopup>
      </Tooltip>
      <Button size="xs" className="mx-1" onClick={() => openEditor({})}>
        <Plus />
        New item
      </Button>
      <UserMenu />
    </div>
  );
}

export interface Crumb {
  label: string;
  to?: string;
}

/**
 * A page: the 40px sticky header (sidebar toggle, breadcrumb, page actions,
 * shared actions) over the content, as the reference lays out every screen.
 */
export function Page({
  title,
  crumbs = [],
  actions,
  children,
  className,
  fill = false,
}: {
  title: string;
  crumbs?: Crumb[];
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Content fills the viewport (split panes) instead of scrolling as a column. */
  fill?: boolean;
}) {
  return (
    <>
      <header className="sticky top-0 z-20 flex h-10 shrink-0 items-center gap-2 border-border border-b bg-card p-2 md:rounded-t-xl">
        <SidebarTrigger className="-ml-1 h-6 w-6" />
        <div className="mx-1.5 h-4 w-px shrink-0 bg-border/80" />
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-xs">
          <Link to="/" className="text-card-foreground/70 hover:text-card-foreground">
            Minions
          </Link>
          {[...crumbs, { label: title }].map((c) => (
            <span key={`${c.to ?? ""}${c.label}`} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
              {c.to ? (
                <Link
                  to={c.to}
                  className="truncate text-card-foreground/70 hover:text-card-foreground"
                >
                  {c.label}
                </Link>
              ) : (
                <span className="truncate text-card-foreground">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
        {actions && <div className="ml-3 hidden items-center gap-1.5 sm:flex">{actions}</div>}
        <HeaderActions />
      </header>
      <div className={cn(fill ? "flex min-h-0 flex-1" : "flex-1", className)}>{children}</div>
    </>
  );
}

/** The reference's page body: centred column, title and subtitle. */
export function PageBody({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 md:p-6", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {title && <h1 className="font-semibold text-xl">{title}</h1>}
            {subtitle && <p className="text-muted-foreground text-sm">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Section({
  title,
  hint,
  action,
  children,
  className,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold text-sm">{title}</h2>
          {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="py-4 text-center text-muted-foreground text-xs">{children}</p>;
}
