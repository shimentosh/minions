import {
  type Page as ApiPage,
  analyzeImport,
  type ExistingItemSummary,
  getItemType,
  type ImportAnalysis,
  type ImportRecord,
  type ImportSource,
  ITEM_TYPES,
  parseImport,
  type VaultItemSummary,
} from "@minions/core";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, Link2, ShieldCheck, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { EmptyNote, Page, PageBody, Section } from "@/components/layout/page";
import { SimpleSelect } from "@/components/simple-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { errorMessage, get, post } from "@/lib/api";
import { ItemGlyph } from "@/lib/item-icons";
import { useCollections, useInvalidateVault, useProjects } from "@/lib/queries";
import { toast } from "@/lib/toast";
import { encryptDraft } from "@/lib/vault-crypto";

const SOURCES: { value: ImportSource | "auto"; label: string }[] = [
  { value: "auto", label: "Detect automatically" },
  { value: "notion", label: "Notion (CSV export)" },
  { value: "chrome", label: "Chrome / Edge passwords (CSV)" },
  { value: "firefox", label: "Firefox passwords (CSV)" },
  { value: "bitwarden-csv", label: "Bitwarden (CSV)" },
  { value: "bitwarden-json", label: "Bitwarden (unencrypted JSON)" },
  { value: "csv", label: "Any CSV" },
  { value: "json", label: "Any JSON array" },
];

const ISSUE_LABEL: Record<ImportRecord["issues"][number], string> = {
  invalid_url: "invalid URL",
  missing_password: "no password",
  missing_username: "no username",
  unknown_type: "unknown type",
  empty: "empty",
};

/** Fetches existing items' safe metadata for duplicate checks, page by page. */
async function loadExisting(): Promise<ExistingItemSummary[]> {
  const out: ExistingItemSummary[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await get<ApiPage<VaultItemSummary>>("/vault/items", {
      limit: 200,
      cursor,
      sort: "name",
    });
    out.push(
      ...page.items.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        host: p.host,
        username: p.username,
      })),
    );
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

const familyKind = (r: ImportRecord) =>
  r.type === "TOTP" ? "TWO_FACTOR_FOR" : r.type === "RECOVERY_CODE" ? "RECOVERY_FOR" : "USED_FOR";

export function ImportPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const invalidate = useInvalidateVault();
  const { data: projects } = useProjects();
  const { data: collections } = useCollections();
  const [source, setSource] = useState<ImportSource | "auto">("auto");
  const [parsed, setParsed] = useState<{
    source: ImportSource;
    records: ImportRecord[];
    file: string;
  } | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<Set<number>>(new Set());
  const [projectId, setProjectId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [foldersAsCollections, setFoldersAsCollections] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ imported: number; failed: number } | null>(null);

  async function onFile(file: File) {
    setResult(null);
    if (file.size > 20 * 1024 * 1024)
      return toast.error("File is too large", "Split it into files under 20 MB.");
    try {
      // Read and parsed in this tab. The file never goes to the server.
      const text = await file.text();
      const out = parseImport(text, source, file.name);
      const existing = await loadExisting();
      const a = analyzeImport(out.records, existing);
      setParsed({ ...out, file: file.name });
      setAnalysis(a);
      setTypes({});
      setGroups(new Set(a.groups.map((_, i) => i)));
      // Preselect everything except empties and exact duplicates of existing items.
      setSelected(
        new Set(
          out.records
            .filter((r) => !r.issues.includes("empty") && !a.duplicatesOfExisting[r.ref])
            .map((r) => r.ref),
        ),
      );
    } catch (e) {
      toast.error("Couldn't read that file", e instanceof Error ? e.message : undefined);
    }
  }

  const records = parsed?.records ?? [];
  const byRef = useMemo(() => new Map(records.map((r) => [r.ref, r])), [records]);

  async function runImport() {
    if (!parsed || !analysis) return;
    const chosen = records.filter((r) => selected.has(r.ref));
    setProgress({ done: 0, total: chosen.length });
    try {
      const job = await post<{ id: string }>("/imports", {
        source: parsed.source,
        totalRecords: records.length,
        duplicateCount:
          Object.keys(analysis.duplicatesOfExisting).length +
          analysis.duplicatesInFile.reduce((n, d) => n + d.refs.length - 1, 0),
        invalidCount: analysis.invalidUrls,
      });

      // Folders become collections when asked, created once up front.
      const folderIds = new Map<string, string>();
      if (foldersAsCollections && !collectionId) {
        for (const folder of new Set(chosen.map((r) => r.folder).filter((f): f is string => !!f))) {
          const found = collections?.find((c) => c.name.toLowerCase() === folder.toLowerCase());
          folderIds.set(
            folder,
            found?.id ??
              (await post<{ id: string }>("/collections", { name: folder.slice(0, 80) })).id,
          );
        }
      }

      const ids = new Map<string, string>();
      let imported = 0;
      let failed = 0;
      for (let i = 0; i < chosen.length; i += 100) {
        const slice = chosen.slice(i, i + 100);
        const entries = [];
        for (const r of slice) {
          const id = crypto.randomUUID();
          ids.set(r.ref, id);
          const type = types[r.ref] ?? r.type;
          entries.push({
            sourceRow: r.sourceRow,
            item: await encryptDraft({
              id,
              type,
              name: r.name,
              favorite: r.favorite,
              tags: r.tags,
              projectId: projectId || null,
              collectionId: collectionId || (r.folder ? (folderIds.get(r.folder) ?? null) : null),
              values: r.fields,
            }),
          });
        }
        const res = await post<{ imported: number; failed: { sourceRow: number }[] }>(
          `/imports/${job.id}/items`,
          { entries },
        );
        imported += res.imported;
        failed += res.failed.length;
        for (const f of res.failed) {
          const ref = slice.find((r) => r.sourceRow === f.sourceRow)?.ref;
          if (ref) ids.delete(ref);
        }
        setProgress({ done: Math.min(i + 100, chosen.length), total: chosen.length });
      }

      // Relationships the user accepted ("Gmail" and "YouTube" use the Google account).
      for (const gi of groups) {
        const g = analysis.groups[gi]!;
        const primary = ids.get(g.primaryRef);
        if (!primary) continue;
        for (const ref of g.memberRefs) {
          const member = ids.get(ref);
          const rec = byRef.get(ref);
          if (member && rec)
            await post("/relations", {
              fromItemId: primary,
              toItemId: member,
              kind: familyKind(rec),
            }).catch(() => undefined);
        }
      }

      await post(`/imports/${job.id}/complete`, { skippedCount: records.length - chosen.length });
      setResult({ imported, failed });
      setParsed(null);
      setAnalysis(null);
      await invalidate();
      void qc.invalidateQueries({ queryKey: ["collections"] });
      toast.success(`Imported ${imported} item${imported === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error("Import stopped", errorMessage(e));
    } finally {
      setProgress(null);
    }
  }

  return (
    <Page title="Import">
      <PageBody
        title="Import Center"
        subtitle="Bring in passwords and secrets from Notion, browsers, Bitwarden, CSV or JSON. Files are read on this device and encrypted before anything is sent."
      >
        {!parsed && (
          <Section title="Choose a file">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-64 space-y-1.5">
                <span className="text-muted-foreground text-xs">Source</span>
                <SimpleSelect
                  value={source}
                  onChange={(v) => setSource(v as ImportSource | "auto")}
                  options={SOURCES}
                />
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.json,text/csv,application/json"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])}
              />
              <Button onClick={() => fileRef.current?.click()}>
                <FileUp /> Choose file…
              </Button>
            </div>
            <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
              <ShieldCheck className="mt-px size-3.5 shrink-0 text-emerald-500" />
              Delete the exported file from your computer once the import finishes. It holds your
              passwords in plain text.
            </p>
            {result && (
              <p className="rounded-lg bg-emerald-500/8 px-3 py-2 text-emerald-700 text-sm dark:text-emerald-400">
                Imported {result.imported} item{result.imported === 1 ? "" : "s"}
                {result.failed ? `, ${result.failed} failed` : ""}.
              </p>
            )}
          </Section>
        )}

        {parsed && analysis && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                ["Records found", analysis.total],
                [
                  "Possible duplicates",
                  Object.keys(analysis.duplicatesOfExisting).length +
                    analysis.duplicatesInFile.length,
                ],
                ["Incomplete", analysis.incomplete],
                ["Invalid URLs", analysis.invalidUrls],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border bg-card px-4 py-3">
                  <div className="text-muted-foreground text-xs">{label}</div>
                  <div className="mt-1 font-semibold text-2xl tabular-nums">{value}</div>
                </div>
              ))}
            </div>

            <Section
              title="Options"
              hint={`${parsed.file} · read as ${SOURCES.find((s) => s.value === parsed.source)?.label}`}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <span className="text-muted-foreground text-xs">Put everything in project</span>
                  <SimpleSelect
                    value={projectId}
                    onChange={setProjectId}
                    allowEmpty
                    options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <span className="text-muted-foreground text-xs">Collection</span>
                  <SimpleSelect
                    value={collectionId}
                    onChange={setCollectionId}
                    allowEmpty
                    emptyLabel="From folders / none"
                    options={(collections ?? []).map((c) => ({ value: c.id, label: c.name }))}
                  />
                </div>
                <label className="flex items-center gap-2 self-end text-sm">
                  <Switch
                    checked={foldersAsCollections}
                    onCheckedChange={setFoldersAsCollections}
                    disabled={!!collectionId}
                  />{" "}
                  Folders become collections
                </label>
              </div>
            </Section>

            {analysis.groups.length > 0 && (
              <Section
                title="Accounts that belong together"
                hint="Linked, not merged: each record stays its own item with its own encrypted values."
              >
                {analysis.groups.map((g, i) => (
                  <label
                    key={`${g.family}-${g.identity}`}
                    className="flex items-start gap-3 rounded-lg border px-3 py-2"
                  >
                    <Switch
                      checked={groups.has(i)}
                      onCheckedChange={(on) =>
                        setGroups((s) =>
                          on ? new Set(s).add(i) : new Set([...s].filter((x) => x !== i)),
                        )
                      }
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="flex items-center gap-1.5 font-medium">
                        <Link2 className="size-3.5" /> {g.canonical} · {g.identity}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {byRef.get(g.primaryRef)?.name} ←{" "}
                        {g.memberRefs.map((r) => byRef.get(r)?.name).join(", ")}
                      </div>
                    </div>
                  </label>
                ))}
              </Section>
            )}

            <Section
              title={`Preview · ${selected.size} of ${records.length} selected`}
              action={
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setSelected(new Set(records.map((r) => r.ref)))}
                  >
                    All
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
                    None
                  </Button>
                </div>
              }
            >
              {records.length === 0 && <EmptyNote>No records in this file.</EmptyNote>}
              <div className="max-h-[28rem] overflow-y-auto">
                {records.map((r) => {
                  const dupe = analysis.duplicatesOfExisting[r.ref];
                  const type = types[r.ref] ?? r.type;
                  return (
                    <div
                      key={r.ref}
                      className="flex items-center gap-3 border-border/60 border-b py-1.5 last:border-b-0"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(r.ref)}
                        onChange={(e) =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(r.ref);
                            else n.delete(r.ref);
                            return n;
                          })
                        }
                        aria-label={`Import ${r.name}`}
                      />
                      <ItemGlyph type={type} className="size-7 [&_svg]:size-3.5" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{r.name}</div>
                        <div className="truncate text-muted-foreground text-xs">
                          {[r.host, r.fields.username || r.fields.email, r.folder]
                            .filter(Boolean)
                            .join(" · ") || `row ${r.sourceRow}`}
                        </div>
                      </div>
                      {dupe && (
                        <Badge variant="warning" size="sm">
                          already in vault
                        </Badge>
                      )}
                      {r.issues
                        .filter((x) => x !== "unknown_type")
                        .map((x) => (
                          <Badge key={x} variant="outline" size="sm">
                            <TriangleAlert className="size-3" /> {ISSUE_LABEL[x]}
                          </Badge>
                        ))}
                      <SimpleSelect
                        size="sm"
                        className="w-40 min-w-0"
                        value={type}
                        onChange={(v) => setTypes((t) => ({ ...t, [r.ref]: v }))}
                        options={ITEM_TYPES.map((t) => ({ value: t.type, label: t.label }))}
                      />
                    </div>
                  );
                })}
              </div>
            </Section>

            <div className="flex flex-wrap items-center justify-end gap-2">
              {progress && (
                <div className="mr-auto flex w-64 items-center gap-2 text-muted-foreground text-xs">
                  <Progress
                    value={(progress.done / Math.max(progress.total, 1)) * 100}
                    className="flex-1"
                  >
                    <ProgressTrack>
                      <ProgressIndicator />
                    </ProgressTrack>
                  </Progress>
                  {progress.done}/{progress.total}
                </div>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  setParsed(null);
                  setAnalysis(null);
                }}
                disabled={!!progress}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void runImport()}
                loading={!!progress}
                disabled={selected.size === 0}
              >
                Encrypt & import {selected.size} item{selected.size === 1 ? "" : "s"}
              </Button>
            </div>
            <p className="text-right text-muted-foreground text-xs">
              Types:{" "}
              {Object.entries(analysis.byType)
                .map(([t, n]) => `${n} ${getItemType(t)?.plural.toLowerCase() ?? t}`)
                .join(", ")}
            </p>
          </>
        )}
      </PageBody>
    </Page>
  );
}
