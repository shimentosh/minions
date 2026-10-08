import type { FindingType, VaultItemSummary } from "@minions/core";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Clock,
  FolderKanban,
  type LucideIcon,
  MonitorSmartphone,
  PencilLine,
  SearchIcon,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { EmptyNote, Page } from "@/components/layout/page";
import { Skeleton } from "@/components/ui/skeleton";
import { useDropTarget } from "@/components/vault/organize";
import { cn } from "@/lib/cn";
import { ACTION_LABELS, firstName, greeting, timeAgo } from "@/lib/format";
import { ItemGlyph } from "@/lib/item-icons";
import { useDashboard, useSecurity } from "@/lib/queries";
import { useSession } from "@/lib/session";

type Tone = "default" | "good" | "warn" | "danger";
const TONE: Record<Tone, string> = {
  default: "bg-muted text-muted-foreground",
  good: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  danger: "bg-red-500/10 text-red-600 dark:text-red-400",
};

/** The reference's StatCard: one number worth knowing, linking to its source. */
export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
  to,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  to?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">{label}</span>
        <span className={cn("flex size-7 items-center justify-center rounded-lg", TONE[tone])}>
          <Icon className="size-3.5" />
        </span>
      </div>
      <div className="mt-1 font-semibold text-2xl tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 truncate text-muted-foreground text-xs">{hint}</div>}
    </>
  );
  const className =
    "block h-full rounded-xl border border-border bg-card px-4 py-3 transition-colors";
  return to ? (
    <Link to={to} className={cn(className, "hover:bg-accent/40")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

function ItemLink({ item, right }: { item: VaultItemSummary; right?: React.ReactNode }) {
  return (
    <Link
      to="/vault"
      search={{ item: item.id }}
      className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-accent/60"
    >
      <ItemGlyph type={item.type} className="size-7 [&_svg]:size-3.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{item.name}</span>
        {item.subtitle && (
          <span className="block truncate text-muted-foreground text-xs">{item.subtitle}</span>
        )}
      </span>
      {right && <span className="shrink-0 text-muted-foreground text-xs">{right}</span>}
    </Link>
  );
}

const ATTENTION: [FindingType, string][] = [
  ["reused_password", "reused"],
  ["weak_password", "weak"],
  ["missing_2fa", "without 2FA"],
  ["expiring", "expiring soon"],
  ["expired", "expired"],
  ["duplicate", "possible duplicates"],
];

/** A project on Home: opens it, and takes items dropped on it. */
function ProjectTile({
  p,
}: {
  p: { id: string; name: string; color?: string | null; itemCount: number };
}) {
  const drop = useDropTarget({ kind: "project", id: p.id, name: p.name });
  return (
    <Link
      ref={drop.setNodeRef}
      to="/projects/$projectId"
      params={{ projectId: p.id }}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border border-border/70 px-3 py-2 transition-colors hover:bg-accent/40",
        drop.dragging && "border-dashed",
        drop.isOver && "border-primary/60 bg-primary/8",
      )}
    >
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-lg"
        style={{ background: `${p.color ?? "#64748b"}22`, color: p.color ?? undefined }}
      >
        <FolderKanban className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
      <span className="text-muted-foreground text-xs tabular-nums">{p.itemCount}</span>
    </Link>
  );
}

const linkCls = "text-muted-foreground text-xs hover:text-foreground";

/** A Home card whose list scrolls inside it, so the page itself fits the screen. */
function Card({
  title,
  action,
  children,
  className,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex min-h-64 min-w-0 flex-col rounded-xl border border-border bg-card lg:min-h-0",
        className,
      )}
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-border/60 border-b px-4">
        <h2 className="font-semibold text-sm">{title}</h2>
        {action}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
    </section>
  );
}

type Quick = "favorites" | "recent" | "frequent";

export function DashboardPage() {
  const me = useSession((s) => s.me);
  const { data, isLoading } = useDashboard();
  const { data: security } = useSecurity();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [quick, setQuick] = useState<Quick>("favorites");

  const since = data?.sinceLastVisit;
  const score = security?.score;
  const scoreTone: Tone =
    score == null ? "default" : score >= 85 ? "good" : score >= 60 ? "warn" : "danger";
  const attention = ATTENTION.filter(([t]) => security?.counts[t]);

  const quickItems =
    quick === "favorites" ? data?.favorites : quick === "recent" ? data?.recent : data?.frequent;
  const quickEmpty = {
    favorites: "Star an item to keep it here.",
    recent: "Items you open or copy show up here.",
    frequent: "Nothing used yet.",
  }[quick];

  return (
    <Page title="Reports" className="lg:min-h-0">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 md:p-6 lg:h-full lg:min-h-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-semibold text-xl">Reports</h1>
            <p className="text-muted-foreground text-sm">
              {greeting()}
              {me ? `, ${firstName(me.user.name)}` : ""}. Your vault at a glance.
            </p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void navigate({ to: "/vault", search: { q: q || undefined } });
            }}
            className="relative w-full sm:w-80"
          >
            <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 z-10 size-4 text-muted-foreground/70" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search your vault…"
              className="h-9 w-full rounded-lg border border-input bg-card ps-9 pe-3 text-sm shadow-xs/5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
            />
          </form>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-3 md:grid-cols-4">
          {isLoading ? (
            ["a", "b", "c", "d"].map((k) => <Skeleton key={k} className="h-[5.5rem] rounded-xl" />)
          ) : (
            <>
              <StatCard
                icon={ShieldCheck}
                label="Security health"
                value={score == null ? "—" : `${score}%`}
                hint={
                  score == null
                    ? "Add items to get a score"
                    : (security?.factors.find((f) => !f.ok)?.detail ?? "All checks pass")
                }
                tone={scoreTone}
                to="/security"
              />
              <StatCard
                icon={ShieldAlert}
                label="Needs attention"
                value={since?.openIssues ?? 0}
                hint={
                  attention.length
                    ? attention
                        .slice(0, 3)
                        .map(([t, l]) => `${security!.counts[t]} ${l}`)
                        .join(" · ")
                    : "Nothing urgent"
                }
                tone={since?.openIssues ? "warn" : "good"}
                to="/security"
              />
              <StatCard
                icon={PencilLine}
                label="Since your last visit"
                value={(since?.created ?? 0) + (since?.updated ?? 0)}
                hint={
                  since?.since
                    ? `${since.created} created · ${since.updated} updated`
                    : "Welcome to Minions"
                }
                to="/activity"
              />
              <StatCard
                icon={MonitorSmartphone}
                label="New devices"
                value={since?.devices ?? 0}
                hint={since?.since ? `since ${timeAgo(since.since)}` : "This device is registered"}
                tone={since?.devices ? "warn" : "default"}
                to="/devices"
              />
            </>
          )}
        </div>

        <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-3">
          <Card
            title="Projects"
            action={
              <Link to="/projects" className={linkCls}>
                All
              </Link>
            }
          >
            {data?.projects.length ? (
              <div className="space-y-1.5 p-1">
                {data.projects.map((p) => (
                  <ProjectTile key={p.id} p={p} />
                ))}
              </div>
            ) : (
              <EmptyNote>Group accounts, keys and servers by what they belong to.</EmptyNote>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-0.5">
                {(
                  [
                    ["favorites", "Favorites"],
                    ["recent", "Recent"],
                    ["frequent", "Most used"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setQuick(k)}
                    className={cn(
                      "rounded-md px-2 py-1 text-[13px]",
                      quick === k
                        ? "bg-accent font-semibold text-foreground"
                        : "font-normal text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </span>
            }
            action={
              <Link
                to="/vault"
                search={quick === "favorites" ? { favorite: true } : { sort: quick }}
                className={linkCls}
              >
                All
              </Link>
            }
          >
            {quickItems?.length ? (
              quickItems.map((i) => (
                <ItemLink
                  key={i.id}
                  item={i}
                  right={
                    quick === "recent"
                      ? timeAgo(i.lastAccessedAt)
                      : quick === "frequent"
                        ? `${i.accessCount} uses`
                        : undefined
                  }
                />
              ))
            ) : (
              <EmptyNote>{quickEmpty}</EmptyNote>
            )}
            {quick === "frequent" && data && data.neverUsedCount > 0 && (
              <Link
                to="/cleanup"
                className="mt-1 flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-2 text-muted-foreground text-xs hover:text-foreground"
              >
                <Clock className="size-3.5" />
                {data.neverUsedCount} item{data.neverUsedCount === 1 ? " hasn't" : "s haven't"} been
                used in 180 days
              </Link>
            )}
          </Card>

          <Card
            title="Recent activity"
            action={
              <Link to="/activity" className={linkCls}>
                All
              </Link>
            }
          >
            {data?.activity.length ? (
              data.activity.map((a) => (
                <div key={a.id} className="flex items-center gap-2.5 px-1.5 py-1.5">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Activity className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {ACTION_LABELS[a.action] ?? a.action}
                    </span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {[a.itemName, a.device].filter(Boolean).join(" · ") || " "}
                    </span>
                  </span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {timeAgo(a.createdAt)}
                  </span>
                </div>
              ))
            ) : (
              <EmptyNote>No activity yet.</EmptyNote>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}
