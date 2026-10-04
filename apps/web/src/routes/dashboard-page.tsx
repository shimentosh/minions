import type { FindingType, VaultItemSummary } from "@minions/core";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ChevronRight,
  Clock,
  FolderKanban,
  type LucideIcon,
  MonitorSmartphone,
  PencilLine,
  Plus,
  SearchIcon,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { EmptyNote, Page, PageBody, Section } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { ACTION_LABELS, firstName, greeting, timeAgo } from "@/lib/format";
import { ItemGlyph } from "@/lib/item-icons";
import { useDashboard, useSecurity } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useUi } from "@/lib/ui-store";

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

export function DashboardPage() {
  const me = useSession((s) => s.me);
  const { data, isLoading } = useDashboard();
  const { data: security } = useSecurity();
  const openEditor = useUi((s) => s.openEditor);
  const setCapture = useUi((s) => s.setCapture);
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  const since = data?.sinceLastVisit;
  const score = security?.score;
  const scoreTone: Tone =
    score == null ? "default" : score >= 85 ? "good" : score >= 60 ? "warn" : "danger";
  const attention = ATTENTION.filter(([t]) => security?.counts[t]);

  return (
    <Page title="Home">
      <PageBody
        title={`${greeting()}${me ? `, ${firstName(me.user.name)}` : ""}`}
        subtitle="Everything sensitive, in one place."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setCapture(true)}>
              <Sparkles /> Quick capture
            </Button>
            <Button size="sm" onClick={() => openEditor({})}>
              <Plus /> New item
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void navigate({ to: "/vault", search: { q: q || undefined } });
          }}
          className="relative"
        >
          <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3.5 z-10 size-4 text-muted-foreground/70" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your vault…"
            className="h-11 w-full rounded-xl border border-input bg-card ps-10 pe-3 text-sm shadow-xs/5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
          />
        </form>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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
                        .slice(0, 2)
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

        {attention.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
            <ShieldAlert className="size-4 text-warning-foreground" />
            <span className="font-medium">Needs attention:</span>
            {attention.map(([t, label]) => (
              <span key={t} className="text-muted-foreground">
                {security!.counts[t]} {label}
              </span>
            ))}
            <Link
              to="/security"
              className="ml-auto flex items-center gap-0.5 text-muted-foreground text-xs hover:text-foreground"
            >
              Review <ChevronRight className="size-3.5" />
            </Link>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <Section
            title="Favorites"
            action={
              <Link
                to="/vault"
                search={{ favorite: true }}
                className="text-muted-foreground text-xs hover:text-foreground"
              >
                All
              </Link>
            }
          >
            {data?.favorites.length ? (
              data.favorites.map((i) => <ItemLink key={i.id} item={i} />)
            ) : (
              <EmptyNote>Star an item to keep it here.</EmptyNote>
            )}
          </Section>
          <Section
            title="Recently used"
            action={
              <Link
                to="/vault"
                search={{ sort: "recent" }}
                className="text-muted-foreground text-xs hover:text-foreground"
              >
                All
              </Link>
            }
          >
            {data?.recent.length ? (
              data.recent.map((i) => (
                <ItemLink key={i.id} item={i} right={timeAgo(i.lastAccessedAt)} />
              ))
            ) : (
              <EmptyNote>Items you open or copy show up here.</EmptyNote>
            )}
          </Section>
          <Section
            title="Recent activity"
            action={
              <Link to="/activity" className="text-muted-foreground text-xs hover:text-foreground">
                All
              </Link>
            }
          >
            {data?.activity.length ? (
              data.activity.map((a) => (
                <div key={a.id} className="flex items-center gap-2.5 px-1.5 py-1">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Activity className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {ACTION_LABELS[a.action] ?? a.action}
                    </span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {[a.itemName, a.device].filter(Boolean).join(" · ") || " "}
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
          </Section>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Section
            title="Projects"
            className="lg:col-span-2"
            action={
              <Link to="/projects" className="text-muted-foreground text-xs hover:text-foreground">
                All
              </Link>
            }
          >
            {data?.projects.length ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {data.projects.map((p) => (
                  <Link
                    key={p.id}
                    to="/projects/$projectId"
                    params={{ projectId: p.id }}
                    className="flex items-center gap-2.5 rounded-lg border border-border/70 px-3 py-2 hover:bg-accent/40"
                  >
                    <span
                      className="flex size-7 items-center justify-center rounded-lg"
                      style={{
                        background: `${p.color ?? "#64748b"}22`,
                        color: p.color ?? undefined,
                      }}
                    >
                      <FolderKanban className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {p.itemCount}
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyNote>Group accounts, keys and servers by what they belong to.</EmptyNote>
            )}
          </Section>
          <Section title="Most used">
            {data?.frequent.length ? (
              data.frequent.map((i) => (
                <ItemLink key={i.id} item={i} right={`${i.accessCount} uses`} />
              ))
            ) : (
              <EmptyNote>Nothing yet.</EmptyNote>
            )}
            {data && data.neverUsedCount > 0 && (
              <Link
                to="/cleanup"
                className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-2 text-muted-foreground text-xs hover:text-foreground"
              >
                <Clock className="size-3.5" />
                {data.neverUsedCount} item{data.neverUsedCount === 1 ? " hasn't" : "s haven't"} been
                used in 180 days
              </Link>
            )}
          </Section>
        </div>
      </PageBody>
    </Page>
  );
}
