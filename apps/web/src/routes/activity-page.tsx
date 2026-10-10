import { Link } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyNote, Page, PageBody, Section } from "@/components/layout/page";
import { SimpleSelect } from "@/components/simple-select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ACTION_LABELS, timeAgo } from "@/lib/format";
import { ItemGlyph } from "@/lib/item-icons";
import { useActivity } from "@/lib/queries";

const FILTERS: Record<string, string | undefined> = {
  all: undefined,
  usage: "item.copied,item.autofilled,item.totp_generated,item.revealed,item.viewed",
  changes:
    "item.created,item.updated,item.deleted,item.restored,item.purged,item.merged,note.created,note.updated,note.deleted,import.completed",
  access:
    "auth.login,auth.logout,auth.login_failed,vault.locked,vault.unlocked,vault.unlock_failed,device.added,device.linked,device.revoked,session.revoked,session.revoked_all,vault.exported",
};

export function ActivityPage() {
  const [filter, setFilter] = useState("all");
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useActivity({
    actions: FILTERS[filter],
  });
  const rows = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  // Group by calendar day, newest first.
  const days = useMemo(() => {
    const map = new Map<string, typeof rows>();
    for (const r of rows) {
      const day = new Date(r.createdAt).toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
      });
      map.set(day, [...(map.get(day) ?? []), r]);
    }
    return [...map.entries()];
  }, [rows]);

  return (
    <Page title="Activity">
      <PageBody
        title="Activity"
        subtitle="What happened in your vault. Values are never recorded, only that something was viewed, copied or changed."
        actions={
          <SimpleSelect
            size="sm"
            className="w-44"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All activity" },
              { value: "usage", label: "Views & copies" },
              { value: "changes", label: "Changes" },
              { value: "access", label: "Sign-ins & devices" },
            ]}
          />
        }
      >
        {isLoading && <Skeleton className="h-64 rounded-xl" />}
        {!isLoading && rows.length === 0 && <EmptyNote>No activity yet.</EmptyNote>}
        {days.map(([day, entries]) => (
          <Section key={day} title={day}>
            {entries.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 border-border/60 border-b py-1.5 last:border-b-0"
              >
                {a.itemType && a.itemType !== "NOTE" ? (
                  <ItemGlyph type={a.itemType} className="size-7 [&_svg]:size-3.5" />
                ) : (
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Activity className="size-3.5" />
                  </span>
                )}
                <div className="min-w-0 flex-1 text-sm">
                  <span>{ACTION_LABELS[a.action] ?? a.action}</span>
                  {a.itemName && (
                    <>
                      {" · "}
                      {a.itemId && a.itemType !== "NOTE" ? (
                        <Link
                          to="/vault"
                          search={{ item: a.itemId }}
                          className="font-medium hover:underline"
                        >
                          {a.itemName}
                        </Link>
                      ) : (
                        <span className="font-medium">{a.itemName}</span>
                      )}
                    </>
                  )}
                  {typeof a.metadata?.field === "string" && (
                    <span className="text-muted-foreground">
                      {" "}
                      ({String(a.metadata.field).replace(/^var\./, "")})
                    </span>
                  )}
                </div>
                <span className="hidden max-w-48 truncate text-muted-foreground text-xs md:block">
                  {[a.device, a.ip].filter(Boolean).join(" · ")}
                </span>
                <span className="w-24 shrink-0 text-right text-muted-foreground text-xs">
                  {new Date(a.createdAt).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))}
          </Section>
        ))}
        {hasNextPage && (
          <Button
            variant="outline"
            className="self-center"
            loading={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            Load more
          </Button>
        )}
        {rows.length > 0 && (
          <p className="text-center text-muted-foreground text-xs">
            Latest: {timeAgo(rows[0]!.createdAt)}
          </p>
        )}
      </PageBody>
    </Page>
  );
}
