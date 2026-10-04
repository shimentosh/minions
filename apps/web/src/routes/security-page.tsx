import type { FindingType, SecurityFinding } from "@minions/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CheckCircle2,
  CircleAlert,
  EyeOff,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyNote, Page, PageBody, Section } from "@/components/layout/page";
import { DuplicateReview } from "@/components/security/duplicate-review";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { del, get, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { SECURITY_EVENT_LABELS, timeAgo } from "@/lib/format";
import { ItemGlyph } from "@/lib/item-icons";
import { useInvalidateVault, useSecurity } from "@/lib/queries";
import { useUi } from "@/lib/ui-store";

export const FINDING_LABELS: Record<FindingType, string> = {
  reused_password: "Reused passwords",
  weak_password: "Weak passwords",
  missing_2fa: "Without 2FA",
  expiring: "Expiring soon",
  expired: "Expired",
  duplicate: "Possible duplicates",
  old_password: "Old passwords",
  incomplete: "Incomplete",
  unused: "Unused 180+ days",
};

export function FindingRow({ finding }: { finding: SecurityFinding }) {
  const openEditor = useUi((s) => s.openEditor);
  const invalidate = useInvalidateVault();
  const [review, setReview] = useState(false);
  const dismiss = useMutation({
    mutationFn: () =>
      finding.dismissed
        ? del("/security/findings/state", { key: finding.key })
        : post("/security/findings/state", { key: finding.key, status: "dismissed" }),
    onSuccess: () => void invalidate(),
  });
  const first = finding.items[0];
  const Icon = finding.severity === "high" ? CircleAlert : TriangleAlert;

  let action: React.ReactNode = null;
  if (finding.type === "duplicate")
    action = (
      <Button size="xs" variant="outline" onClick={() => setReview(true)}>
        Review
      </Button>
    );
  else if (
    [
      "weak_password",
      "reused_password",
      "old_password",
      "expired",
      "expiring",
      "missing_2fa",
      "incomplete",
    ].includes(finding.type) &&
    first
  ) {
    const label =
      finding.type === "missing_2fa"
        ? "Add 2FA"
        : finding.type === "incomplete"
          ? "Complete"
          : finding.type.includes("password")
            ? "Change password"
            : "Rotate";
    action = (
      <Button size="xs" variant="outline" onClick={() => openEditor({ itemId: first.id })}>
        {label}
      </Button>
    );
  } else if (first) {
    action = (
      <Button size="xs" variant="outline" render={<Link to="/vault" search={{ item: first.id }} />}>
        Review
      </Button>
    );
  }

  return (
    <div
      className={cn(
        "flex items-start gap-3 border-border/60 border-b px-1 py-2.5 last:border-b-0",
        finding.dismissed && "opacity-60",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          finding.severity === "high"
            ? "text-red-500"
            : finding.severity === "medium"
              ? "text-amber-500"
              : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm">{finding.title}</div>
        <div className="text-muted-foreground text-xs">{finding.detail}</div>
        {finding.items.length > 1 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {finding.items.map((i) => (
              <Link
                key={i.id}
                to="/vault"
                search={{ item: i.id }}
                className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs hover:bg-accent"
              >
                <ItemGlyph type={i.type} className="size-4 rounded [&_svg]:size-2.5" />
                {i.name}
              </Link>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!finding.dismissed && action}
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => dismiss.mutate()}
          title={finding.dismissed ? "Restore" : "Dismiss"}
          aria-label={finding.dismissed ? "Restore finding" : "Dismiss finding"}
        >
          {finding.dismissed ? <RotateCcw /> : <EyeOff />}
        </Button>
      </div>
      {review && <DuplicateReview finding={finding} open={review} onOpenChange={setReview} />}
    </div>
  );
}

interface SecurityEventRow {
  id: string;
  type: string;
  severity: string;
  device: string | null;
  ip: string | null;
  createdAt: string;
}

export function SecurityPage() {
  const { data, isLoading } = useSecurity();
  const [filter, setFilter] = useState<FindingType | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const events = useQuery({
    queryKey: ["security-events"],
    queryFn: () => get<SecurityEventRow[]>("/security/events", { limit: 30 }),
  });

  // Each type arrives with its first page; "Show more" fetches the rest.
  const [extra, setExtra] = useState<Record<string, SecurityFinding[]>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new overview replaces the extra pages
  useEffect(() => setExtra({}), [data]);
  const all = [...(data?.findings ?? []), ...Object.values(extra).flat()];
  const findings = all.filter(
    (f) => (showDismissed || !f.dismissed) && (!filter || f.type === filter),
  );
  const shownOfType = filter ? all.filter((f) => f.type === filter).length : 0;
  const totalOfType = filter ? (data?.findingTotals[filter] ?? 0) : 0;
  async function loadMore() {
    if (!filter) return;
    setLoadingMore(true);
    try {
      const next = await get<SecurityFinding[]>("/security/findings/page", {
        type: filter,
        offset: shownOfType,
        limit: 100,
      });
      setExtra((e) => ({ ...e, [filter]: [...(e[filter] ?? []), ...next] }));
    } finally {
      setLoadingMore(false);
    }
  }
  const score = data?.score;

  return (
    <Page title="Security Center">
      <PageBody
        title="Security Center"
        subtitle="Computed from your vault's metadata and keyed fingerprints. No secret is ever read on the server."
      >
        {isLoading ? (
          <Skeleton className="h-48 rounded-xl" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-3">
            <Section title="Security health" hint="How the score is made">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "font-semibold text-4xl tabular-nums",
                    score == null
                      ? ""
                      : score >= 85
                        ? "text-emerald-600 dark:text-emerald-400"
                        : score >= 60
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-red-600 dark:text-red-400",
                  )}
                >
                  {score == null ? "—" : `${score}%`}
                </span>
                <span className="text-muted-foreground text-xs">
                  {data?.totalItems} items checked
                </span>
              </div>
              <ul className="space-y-1.5">
                {data?.factors.map((f) => (
                  <li key={f.label} className="flex items-start gap-2 text-sm">
                    {f.ok ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                    ) : (
                      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{f.label}</span>{" "}
                      <span className="text-muted-foreground">· {f.detail}</span>
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">{f.weight}%</span>
                  </li>
                ))}
                {data?.factors.length === 0 && <EmptyNote>Add items to get a score.</EmptyNote>}
              </ul>
            </Section>
            <Section
              title="Needs attention"
              className="lg:col-span-2"
              action={
                <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <input
                    type="checkbox"
                    checked={showDismissed}
                    onChange={(e) => setShowDismissed(e.target.checked)}
                  />{" "}
                  Show dismissed
                </label>
              }
            >
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="xs"
                  variant={filter === null ? "secondary" : "ghost"}
                  onClick={() => setFilter(null)}
                >
                  All
                </Button>
                {(Object.keys(FINDING_LABELS) as FindingType[])
                  .filter((t) => data?.counts[t])
                  .map((t) => (
                    <Button
                      key={t}
                      size="xs"
                      variant={filter === t ? "secondary" : "ghost"}
                      onClick={() => setFilter(t)}
                    >
                      {FINDING_LABELS[t]}
                      <Badge variant="outline" size="sm">
                        {data!.counts[t]}
                      </Badge>
                    </Button>
                  ))}
              </div>
              <div>
                {findings.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <ShieldCheck className="size-8 text-emerald-500" />
                    <p className="font-medium text-sm">Nothing needs attention</p>
                    <p className="text-muted-foreground text-xs">
                      Minions keeps checking as your vault changes.
                    </p>
                  </div>
                ) : (
                  findings.map((f) => <FindingRow key={f.key} finding={f} />)
                )}
                {filter && shownOfType < totalOfType && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    loading={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    Show more ({totalOfType - shownOfType} left)
                  </Button>
                )}
                {!filter &&
                  findings.length > 0 &&
                  Object.entries(data?.findingTotals ?? {}).some(
                    ([t, n]) => (n ?? 0) > all.filter((f) => f.type === t).length,
                  ) && (
                    <p className="mt-2 text-muted-foreground text-xs">
                      Showing the first 50 of each kind. Pick a kind above to see them all.
                    </p>
                  )}
              </div>
            </Section>
          </div>
        )}

        <Section title="Security events" hint="Sign-ins, new devices and account changes">
          {events.data?.length === 0 && <EmptyNote>No security events.</EmptyNote>}
          {events.data?.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-3 border-border/60 border-b py-2 text-sm last:border-b-0"
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  e.severity === "critical"
                    ? "bg-red-500"
                    : e.severity === "warning"
                      ? "bg-amber-500"
                      : "bg-muted-foreground/40",
                )}
              />
              <span className="min-w-0 flex-1 truncate">
                {SECURITY_EVENT_LABELS[e.type] ?? e.type}
              </span>
              <span className="hidden truncate text-muted-foreground text-xs sm:block">
                {[e.device, e.ip].filter(Boolean).join(" · ")}
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">{timeAgo(e.createdAt)}</span>
            </div>
          ))}
        </Section>
      </PageBody>
    </Page>
  );
}
