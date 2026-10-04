import { aad, encryptString, type ItemField, parseTotp } from "@minions/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ImageUp, Plus, SearchIcon, Star, Timer } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Page, PageBody } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TotpCode } from "@/components/vault/totp-code";
import { errorMessage, get, post } from "@/lib/api";
import { ItemGlyph } from "@/lib/item-icons";
import { decodeQrImage, parseGoogleMigration } from "@/lib/qr";
import { useInvalidateVault } from "@/lib/queries";
import { requireVaultKey } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useUi } from "@/lib/ui-store";
import { revealField } from "@/lib/vault-crypto";

interface TotpRow {
  id: string;
  name: string;
  type: string;
  subtitle: string | null;
  favorite: boolean;
  field: ItemField;
}

/**
 * Every 2FA code in the vault, live, like an authenticator app. Secrets are
 * decrypted on this device while the page is open and dropped when it closes.
 */
export function AuthenticatorPage() {
  const openEditor = useUi((s) => s.openEditor);
  const invalidate = useInvalidateVault();
  const fileRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["totp-items"],
    queryFn: () => get<TotpRow[]>("/vault/items/totp"),
    staleTime: 0,
  });

  useEffect(() => {
    if (!data) return;
    let alive = true;
    (async () => {
      const out: Record<string, string> = {};
      for (const row of data) {
        try {
          out[row.id] = await revealField(row.id, row.field);
        } catch {
          /* shown as unreadable */
        }
      }
      if (alive) setSecrets(out);
    })();
    return () => {
      alive = false;
      setSecrets({});
    };
  }, [data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? [])
      .filter((r) => !needle || `${r.name} ${r.subtitle ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  }, [data, q]);

  /** Google Authenticator → Transfer accounts → Export, as screenshots. */
  async function importImages(files: FileList) {
    let added = 0;
    try {
      for (const file of [...files]) {
        const text = await decodeQrImage(file);
        if (!text) continue;
        const accounts = text.startsWith("otpauth-migration://")
          ? parseGoogleMigration(text)
          : text.toLowerCase().startsWith("otpauth://")
            ? [
                {
                  issuer: parseTotp(text).issuer ?? "",
                  account: parseTotp(text).account ?? "",
                  uri: text,
                },
              ]
            : [];
        for (const a of accounts) {
          const id = crypto.randomUUID();
          const fields: ItemField[] = [
            {
              key: "totp",
              value: await encryptString(requireVaultKey(), a.uri, aad.field(id, "totp")),
              sensitive: true,
            },
          ];
          if (a.issuer) fields.push({ key: "issuer", value: a.issuer, sensitive: false });
          if (a.account) fields.push({ key: "account", value: a.account, sensitive: false });
          await post("/vault/items", {
            id,
            type: "TOTP",
            name: a.issuer || a.account || "Authenticator",
            fields,
            tags: ["2fa"],
          });
          added++;
        }
      }
      if (added) {
        toast.success(
          `Added ${added} account${added === 1 ? "" : "s"}`,
          "Remove them from your old authenticator only after checking the codes match.",
        );
        await invalidate();
        void refetch();
      } else toast.error("No 2FA QR codes found in those images");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Page title="Authenticator">
      <PageBody
        title="Authenticator"
        subtitle="Your 2FA codes, live. Click a code to copy it."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && void importImages(e.target.files)}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              title="QR screenshots, including Google Authenticator's “Transfer accounts” export"
            >
              <ImageUp /> Import QR codes
            </Button>
            <Button size="sm" onClick={() => openEditor({ type: "TOTP" })}>
              <Plus /> Add 2FA
            </Button>
          </>
        }
      >
        <div className="relative max-w-sm">
          <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 text-muted-foreground/70" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search accounts…"
            className="ps-8"
          />
        </div>
        {isLoading && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {["a", "b", "c"].map((k) => (
              <Skeleton key={k} className="h-28 rounded-xl" />
            ))}
          </div>
        )}
        {!isLoading && rows.length === 0 && (
          <Empty className="rounded-xl border py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Timer />
              </EmptyMedia>
              <EmptyTitle>{q ? "No matches" : "No 2FA codes yet"}</EmptyTitle>
              <EmptyDescription>
                Add a 2FA secret to any login, paste a QR screenshot, or import everything from
                Google Authenticator (Transfer accounts → Export, then screenshot the QR codes).
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <div
              key={r.id}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-center gap-2.5">
                <ItemGlyph type={r.type} />
                <Link
                  to="/vault"
                  search={{ item: r.id }}
                  className="min-w-0 flex-1 hover:underline"
                >
                  <span className="flex items-center gap-1">
                    <span className="truncate font-medium text-sm">{r.name}</span>
                    {r.favorite && (
                      <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />
                    )}
                  </span>
                  {r.subtitle && (
                    <span className="block truncate text-muted-foreground text-xs">
                      {r.subtitle}
                    </span>
                  )}
                </Link>
              </div>
              {secrets[r.id] ? (
                <TotpCode secret={secrets[r.id]!} itemId={r.id} />
              ) : (
                <span className="text-muted-foreground text-sm">
                  {data && Object.keys(secrets).length ? "Couldn't decrypt" : "…"}
                </span>
              )}
            </div>
          ))}
        </div>
      </PageBody>
    </Page>
  );
}
