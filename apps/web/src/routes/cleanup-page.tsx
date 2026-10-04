import type { FindingType } from "@minions/core";
import { Sparkles } from "lucide-react";
import { EmptyNote, Page, PageBody, Section } from "@/components/layout/page";
import { Skeleton } from "@/components/ui/skeleton";
import { useSecurity } from "@/lib/queries";
import { FindingRow } from "./security-page";

const QUEUES: { type: FindingType; title: string; hint: string }[] = [
  {
    type: "duplicate",
    title: "Duplicates",
    hint: "Same site and same account. Merge, link or keep separate.",
  },
  {
    type: "unused",
    title: "Not used in 180 days",
    hint: "Still needed? Nothing is deleted unless you choose to.",
  },
  {
    type: "incomplete",
    title: "Incomplete or broken",
    hint: "Missing usernames, passwords or a valid website.",
  },
  {
    type: "weak_password",
    title: "Weak passwords",
    hint: "Generate a new one, then update it on the site.",
  },
  {
    type: "missing_2fa",
    title: "Missing 2FA",
    hint: "Accounts at services that offer two-factor sign-in.",
  },
  { type: "old_password", title: "Old credentials", hint: "Not changed in over a year." },
];

export function CleanupPage() {
  const { data, isLoading } = useSecurity();
  const open = (data?.findings ?? []).filter((f) => !f.dismissed);
  const total = QUEUES.reduce((n, q) => n + open.filter((f) => f.type === q.type).length, 0);
  return (
    <Page title="Cleanup">
      <PageBody
        title="Vault cleanup"
        subtitle={
          isLoading
            ? undefined
            : total
              ? `${total} things to review. Every change needs your confirmation.`
              : "Your vault is tidy."
        }
      >
        {isLoading && <Skeleton className="h-48 rounded-xl" />}
        {!isLoading && total === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-16 text-center">
            <Sparkles className="size-8 text-emerald-500" />
            <p className="font-medium text-sm">Nothing to clean up</p>
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {QUEUES.map((q) => {
            const findings = open.filter((f) => f.type === q.type);
            if (!findings.length) return null;
            return (
              <Section key={q.type} title={`${q.title} · ${findings.length}`} hint={q.hint}>
                {findings.slice(0, 25).map((f) => (
                  <FindingRow key={f.key} finding={f} />
                ))}
                {findings.length > 25 && (
                  <EmptyNote>And {findings.length - 25} more in the Security Center.</EmptyNote>
                )}
              </Section>
            );
          })}
        </div>
      </PageBody>
    </Page>
  );
}
