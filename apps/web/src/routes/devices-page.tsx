import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Laptop, LogOut, Puzzle } from "lucide-react";
import { Page, PageBody, Section } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { del, errorMessage, get, post } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";

interface DeviceRow {
  id: string;
  name: string;
  kind: "WEB" | "EXTENSION" | "DESKTOP";
  lastIp: string | null;
  lastActiveAt: string;
  createdAt: string;
  revoked: boolean;
  current: boolean;
  activeSessions: number;
}

interface SessionRow {
  id: string;
  current: boolean;
  device: { name: string; kind: string } | null;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
  vaultUnlocked: boolean;
}

const KIND_ICON = { WEB: Globe, EXTENSION: Puzzle, DESKTOP: Laptop };

function lastActive(iso: string) {
  return Date.now() - new Date(iso).getTime() < 5 * 60_000
    ? "Active now"
    : `Last active ${timeAgo(iso)}`;
}

export function DevicesPage() {
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => get<DeviceRow[]>("/devices") });
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => get<SessionRow[]>("/sessions"),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["devices"] });
    void qc.invalidateQueries({ queryKey: ["sessions"] });
  };
  const revokeDevice = useMutation({
    mutationFn: (id: string) => del(`/devices/${id}`),
    onSuccess: () => {
      toast.success("Device revoked");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revokeSession = useMutation({
    mutationFn: (id: string) => del(`/sessions/${id}`),
    onSuccess: () => {
      toast.success("Session ended");
      refresh();
    },
  });
  const revokeOthers = useMutation({
    mutationFn: () => post<{ revoked: number }>("/sessions/revoke-all", { includeCurrent: false }),
    onSuccess: (r) => {
      toast.success(`Signed out ${r.revoked} other session${r.revoked === 1 ? "" : "s"}`);
      refresh();
    },
  });

  return (
    <Page title="Devices & sessions">
      <PageBody
        title="Devices & sessions"
        subtitle="Everywhere your vault is signed in. Revoking a device signs it out; it needs your master password to come back."
      >
        <Section title="Devices">
          {devices.isLoading && <Skeleton className="h-24" />}
          {devices.data?.map((d) => {
            const Icon = KIND_ICON[d.kind];
            return (
              <div
                key={d.id}
                className="flex items-center gap-3 border-border/60 border-b py-2.5 last:border-b-0"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="truncate font-medium">{d.name}</span>
                    {d.current && (
                      <Badge variant="success" size="sm">
                        This device
                      </Badge>
                    )}
                    {d.revoked && (
                      <Badge variant="error" size="sm">
                        Revoked
                      </Badge>
                    )}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {lastActive(d.lastActiveAt)}
                    {d.lastIp ? ` · ${d.lastIp}` : ""} · added {timeAgo(d.createdAt)}
                  </div>
                </div>
                {!d.current && !d.revoked && (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    loading={revokeDevice.isPending && revokeDevice.variables === d.id}
                    onClick={() => revokeDevice.mutate(d.id)}
                  >
                    Revoke device
                  </Button>
                )}
              </div>
            );
          })}
        </Section>
        <Section
          title="Active sessions"
          action={
            <Button
              size="xs"
              variant="outline"
              onClick={() => revokeOthers.mutate()}
              loading={revokeOthers.isPending}
              disabled={(sessions.data?.length ?? 0) <= 1}
            >
              <LogOut /> Log out all other sessions
            </Button>
          }
        >
          {sessions.isLoading && <Skeleton className="h-24" />}
          {sessions.data?.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 border-border/60 border-b py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm">
                  <span className="truncate">{s.device?.name ?? "Unknown device"}</span>
                  {s.current && (
                    <Badge variant="success" size="sm">
                      Current
                    </Badge>
                  )}
                  {s.vaultUnlocked && (
                    <Badge variant="secondary" size="sm">
                      Unlocked
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground text-xs">
                  {lastActive(s.lastActiveAt)}
                  {s.ip ? ` · ${s.ip}` : ""} · signed in {timeAgo(s.createdAt)}
                </div>
              </div>
              {!s.current && (
                <Button size="xs" variant="outline" onClick={() => revokeSession.mutate(s.id)}>
                  Log out
                </Button>
              )}
            </div>
          ))}
        </Section>
      </PageBody>
    </Page>
  );
}
