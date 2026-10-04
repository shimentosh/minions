import type { OperatorOverview, OperatorUserRow } from "@minions/core";
import { getItemType } from "@minions/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { SearchIcon, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { EmptyNote, Page, PageBody, Section } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, get } from "@/lib/api";
import { shortDate, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";

export function useOperatorStatus() {
  const status = useSession((s) => s.status);
  return useQuery({
    queryKey: ["operator", "status"],
    enabled: status === "unlocked",
    staleTime: 5 * 60_000,
    queryFn: () => get<{ operator: boolean; needsTwoFactor: boolean }>("/operator/status"),
  });
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 font-semibold text-2xl tabular-nums">{value.toLocaleString()}</div>
      {hint && <div className="mt-0.5 text-muted-foreground text-xs">{hint}</div>}
    </div>
  );
}

/** Sign-ups per day, last 30 days: one series, one hue, hover for the value. */
function SignupChart({ data }: { data: OperatorOverview["signupsByDay"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.count));
  const total = data.reduce((n, d) => n + d.count, 0);
  const label = (d: { day: string }) =>
    new Date(`${d.day}T00:00:00Z`).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const h = hover !== null ? data[hover] : null;
  return (
    <figure className="space-y-2">
      <div className="flex h-5 items-baseline justify-between text-xs">
        <span className="text-muted-foreground">
          {h ? (
            <>
              <span className="font-medium text-foreground tabular-nums">{h.count}</span> on{" "}
              {label(h)}
            </>
          ) : (
            <>
              <span className="font-medium text-foreground tabular-nums">{total}</span> in 30 days
            </>
          )}
        </span>
        <span className="text-muted-foreground">max {max}/day</span>
      </div>
      {/* Bars sit on a common baseline; each column is a hover target taller than its bar. */}
      <div
        className="flex h-36 items-end gap-0.5 border-border border-b"
        role="img"
        aria-label={`Sign-ups per day for the last 30 days, ${total} in total`}
        onMouseLeave={() => setHover(null)}
      >
        {data.map((d, i) => (
          <div
            key={d.day}
            className="flex h-full flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            title={`${label(d)}: ${d.count}`}
          >
            <div
              className={`w-full rounded-t-[4px] transition-colors ${hover === i ? "bg-primary" : "bg-primary/70"}`}
              style={{ height: d.count ? `${Math.max(4, (d.count / max) * 100)}%` : "0" }}
            />
          </div>
        ))}
      </div>
      <figcaption className="flex justify-between text-[11px] text-muted-foreground">
        <span>{label(data[0]!)}</span>
        <span>{label(data[data.length - 1]!)}</span>
      </figcaption>
      <table className="sr-only">
        <caption>Sign-ups per day</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.day}>
              <th>{d.day}</th>
              <td>{d.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function Breakdown({ rows }: { rows: { label: string; value: number; sub?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <EmptyNote>Nothing yet.</EmptyNote>;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[8rem_1fr_3.5rem] items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground" title={r.label}>
            {r.label}
          </span>
          <span className="h-2 rounded-[4px] bg-muted">
            <span
              className="block h-2 rounded-[4px] bg-primary/70"
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </span>
          <span className="text-right tabular-nums" title={r.sub}>
            {r.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

function UsersTable() {
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const { data } = useQuery({
    queryKey: ["operator", "users", q, offset],
    placeholderData: keepPreviousData,
    queryFn: () =>
      get<{ total: number; items: OperatorUserRow[] }>("/operator/users", {
        q: q || undefined,
        offset,
        limit: 50,
      }),
  });
  return (
    <Section
      title={`Accounts${data ? ` · ${data.total.toLocaleString()}` : ""}`}
      hint="Account metadata only. Vaults are end-to-end encrypted: there is nothing in them you could see."
      action={
        <div className="relative w-56">
          <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 text-muted-foreground/70" />
          <Input
            size="sm"
            className="ps-8"
            placeholder="Email or name"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
        </div>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="text-left text-muted-foreground text-xs">
            <tr className="border-border border-b">
              <th className="py-2 font-normal">Account</th>
              <th className="py-2 font-normal">Joined</th>
              <th className="py-2 font-normal">Last active</th>
              <th className="py-2 text-right font-normal">Items</th>
              <th className="py-2 text-right font-normal">Imports</th>
              <th className="py-2 text-right font-normal">Workspaces</th>
              <th className="py-2 text-right font-normal">2FA</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((u) => (
              <tr key={u.email} className="border-border/60 border-b last:border-b-0">
                <td className="py-2">
                  <div className="truncate">{u.name}</div>
                  <div className="truncate text-muted-foreground text-xs">{u.email}</div>
                </td>
                <td className="py-2 text-muted-foreground">{shortDate(u.createdAt)}</td>
                <td className="py-2 text-muted-foreground">{timeAgo(u.lastActiveAt)}</td>
                <td className="py-2 text-right tabular-nums">{u.items}</td>
                <td className="py-2 text-right tabular-nums">{u.imports}</td>
                <td className="py-2 text-right tabular-nums">{u.workspaces}</td>
                <td className="py-2 text-right">{u.twoFactor ? "On" : "Off"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > 50 && (
        <div className="flex items-center justify-end gap-2 text-muted-foreground text-xs">
          {offset + 1}–{Math.min(offset + 50, data.total)} of {data.total}
          <Button
            size="xs"
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(offset - 50)}
          >
            Previous
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={offset + 50 >= data.total}
            onClick={() => setOffset(offset + 50)}
          >
            Next
          </Button>
        </div>
      )}
    </Section>
  );
}

/** How the service is used: sign-ups, activity, imports, sharing. For allowlisted operators. */
export function OperatorPage() {
  const { data: status } = useOperatorStatus();
  const { data, error } = useQuery({
    queryKey: ["operator", "overview"],
    enabled: !!status?.operator && !status.needsTwoFactor,
    queryFn: () => get<OperatorOverview>("/operator/overview"),
    refetchInterval: 60_000,
  });

  if (status && !status.operator)
    return (
      <Page title="Not found">
        <p className="p-6 text-muted-foreground text-sm">This page does not exist.</p>
      </Page>
    );

  return (
    <Page title="Operator">
      <PageBody
        title="Service overview"
        subtitle={
          data ? `Updated ${timeAgo(data.generatedAt)}. Refreshes every minute.` : undefined
        }
      >
        {status?.needsTwoFactor && (
          <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/8 p-3 text-sm">
            <ShieldCheck className="size-4 text-warning-foreground" />
            Turn on two-factor authentication in Settings to open the operator dashboard.
          </div>
        )}
        {error && <p className="text-muted-foreground text-sm">{errorMessage(error)}</p>}
        {data && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat
                label="Accounts"
                value={data.users.total}
                hint={`+${data.users.new7d} this week · +${data.users.new30d} in 30 days`}
              />
              <Stat
                label="Active this week"
                value={data.active.week}
                hint={`${data.active.day} today · ${data.active.month} in 30 days`}
              />
              <Stat
                label="Items stored"
                value={data.items.total}
                hint={`${data.items.notes.toLocaleString()} notes`}
              />
              <Stat
                label="Imported items"
                value={data.imports.importedItems}
                hint={`${data.imports.jobs} import${data.imports.jobs === 1 ? "" : "s"}`}
              />
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
              <Section title="Sign-ups per day" className="lg:col-span-2">
                <SignupChart data={data.signupsByDay} />
              </Section>
              <Section title="Security and teams">
                <div className="space-y-2 text-sm">
                  <Row
                    label="Two-factor on"
                    value={`${data.users.total ? Math.round((data.users.twoFactor / data.users.total) * 100) : 0}%`}
                  />
                  <Row label="Workspaces" value={data.workspaces.total} />
                  <Row label="Confirmed members" value={data.workspaces.members} />
                  <Row label="Shared credentials" value={data.workspaces.sharedItems} />
                  <Row label="Browser extensions" value={data.devices.extension ?? 0} />
                  <Row label="Desktop apps" value={data.devices.desktop ?? 0} />
                  <Row label="Web sessions (devices)" value={data.devices.web ?? 0} />
                </div>
              </Section>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <Section title="Items by type">
                <Breakdown
                  rows={data.items.byType
                    .slice(0, 10)
                    .map((t) => ({ label: getItemType(t.type)?.label ?? t.type, value: t.count }))}
                />
              </Section>
              <Section title="Imports by source" hint="Items imported, per source app.">
                <Breakdown
                  rows={data.imports.bySource.map((s) => ({
                    label: s.source,
                    value: s.items,
                    sub: `${s.jobs} import${s.jobs === 1 ? "" : "s"}`,
                  }))}
                />
              </Section>
            </div>
            <UsersTable />
          </>
        )}
      </PageBody>
    </Page>
  );
}

function Row({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
    </div>
  );
}
