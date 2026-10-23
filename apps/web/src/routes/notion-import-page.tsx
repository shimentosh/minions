import { ITEM_TYPES } from "@minions/core";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  FileArchive,
  FileText,
  KeyRound,
  ShieldCheck,
  Table2,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Page, PageBody, Section } from "@/components/layout/page";
import { SimpleSelect } from "@/components/simple-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { describe } from "@/lib/notion/credentials";
import {
  type CredentialChoice,
  type ImportPlan,
  MAX_ATTACHMENT,
  newWriteState,
  planImport,
  type WriteResult,
  writeImport,
} from "@/lib/notion/importer";
import { type NotionExport, subtreeKeys } from "@/lib/notion/parse";
import { usePageActions, usePageTree } from "@/lib/pages/queries";
import { ancestorsOf, childrenOf, pageTitle } from "@/lib/pages/tree";
import { useCollections, useInvalidateVault, useProjects } from "@/lib/queries";
import { toast } from "@/lib/toast";

type Step =
  | { kind: "pick" }
  | { kind: "busy"; stage: string; done: number; total: number }
  | { kind: "preview" }
  | { kind: "done"; result: WriteResult };

const formatBytes = (n: number) =>
  n < 1024 * 1024
    ? `${Math.ceil(n / 1024)} KB`
    : n < 1024 ** 3
      ? `${(n / 1024 / 1024).toFixed(1)} MB`
      : `${(n / 1024 ** 3).toFixed(2)} GB`;

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 font-semibold text-2xl tabular-nums">{value}</div>
      {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
    </div>
  );
}

function TreeNode({
  exp,
  nodeKey,
  depth,
  include,
  setInclude,
  credCount,
}: {
  exp: NotionExport;
  nodeKey: string;
  depth: number;
  include: Set<string>;
  setInclude: (keys: string[], on: boolean) => void;
  credCount: Map<string, number>;
}) {
  const node = exp.nodes.get(nodeKey)!;
  const [open, setOpen] = useState(depth < 1);
  const kids = node.children;
  const on = include.has(nodeKey);
  const rows = node.kind === "database" ? kids.length : 0;
  return (
    <li>
      <div
        className="flex h-8 items-center gap-1.5 rounded-md pe-2 text-sm hover:bg-accent/50"
        style={{ paddingInlineStart: depth * 16 }}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-label={open ? "Collapse" : "Expand"}
          className={cn(
            "flex size-5 items-center justify-center rounded text-muted-foreground",
            !kids.length && "invisible",
          )}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <input
          type="checkbox"
          checked={on}
          aria-label={`Import ${node.title}`}
          onChange={(e) => setInclude(subtreeKeys(exp, nodeKey), e.target.checked)}
        />
        {node.kind === "database" ? (
          <Table2 className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className={cn("truncate", !on && "text-muted-foreground line-through")}>
          {node.title || "Untitled"}
        </span>
        {rows > 0 && (
          <Badge variant="outline" size="sm">
            {rows} rows
          </Badge>
        )}
        {(credCount.get(nodeKey) ?? 0) > 0 && (
          <Badge variant="warning" size="sm">
            <KeyRound className="size-3" /> {credCount.get(nodeKey)}
          </Badge>
        )}
      </div>
      {open && kids.length > 0 && node.kind !== "database" && (
        <ul>
          {kids.map((k) => (
            <TreeNode
              key={k}
              exp={exp}
              nodeKey={k}
              depth={depth + 1}
              include={include}
              setInclude={setInclude}
              credCount={credCount}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function NotionImportPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { pages, index } = usePageTree();
  const pageActions = usePageActions();
  const invalidateVault = useInvalidateVault();
  const { data: projects } = useProjects();
  const { data: collections } = useCollections();
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [include, setIncludeState] = useState<Set<string>>(new Set());
  const [choices, setChoices] = useState<Map<string, CredentialChoice>>(new Map());
  const [target, setTarget] = useState<string>("container");
  const [containerTitle, setContainerTitle] = useState("Notion");
  const [projectId, setProjectId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [showAllCreds, setShowAllCreds] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const state = useRef(newWriteState());
  const [failed, setFailed] = useState<string | null>(null);

  const progress = (stage: string, done: number, total: number) =>
    setStep({ kind: "busy", stage, done, total });

  async function onFiles(list: File[]) {
    const zips = list.filter((f) => /\.zip$/i.test(f.name) || f.type.includes("zip"));
    if (!zips.length)
      return toast.error("Choose the .zip file Notion gave you", "Notion → Settings → Export.");
    try {
      // Read here, in this tab. The export never goes to the server.
      const p = await planImport(zips, progress);
      setPlan(p);
      setIncludeState(new Set(p.exp.nodes.keys()));
      setChoices(
        new Map(p.credentials.map((c) => [c.id, { vault: true, type: c.type, name: c.name }])),
      );
      state.current = newWriteState();
      setFailed(null);
      setStep({ kind: "preview" });
    } catch (e) {
      setStep({ kind: "pick" });
      toast.error("Couldn't read that export", e instanceof Error ? e.message : undefined);
    }
  }

  const setInclude = (keys: string[], on: boolean) =>
    setIncludeState((s) => {
      const next = new Set(s);
      for (const k of keys) on ? next.add(k) : next.delete(k);
      // Including a page includes the pages above it, so it has somewhere to go.
      if (on && plan)
        for (const k of keys) {
          let p = plan.exp.nodes.get(k)?.parentKey;
          while (p) {
            next.add(p);
            p = plan.exp.nodes.get(p)?.parentKey ?? null;
          }
        }
      return next;
    });

  const credCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of plan?.credentials ?? []) m.set(c.nodeKey, (m.get(c.nodeKey) ?? 0) + 1);
    return m;
  }, [plan]);

  const targetOptions = useMemo(() => {
    const opts = [
      { value: "container", label: "A new page that holds everything" },
      { value: "top", label: "The top level of Pages" },
    ];
    for (const p of (pages ?? []).filter((x) => x.kind === "page").slice(0, 500))
      opts.push({
        value: p.id,
        label: `Inside: ${[...ancestorsOf(index, p.id).map(pageTitle), pageTitle(p)].join(" / ")}`,
      });
    return opts;
  }, [pages, index]);

  const includedCreds = (plan?.credentials ?? []).filter((c) => include.has(c.nodeKey));
  const toVault = includedCreds.filter((c) => choices.get(c.id)?.vault !== false).length;
  const includedPages = plan ? [...include].filter((k) => plan.exp.nodes.has(k)).length : 0;

  async function run() {
    if (!plan) return;
    const parentId = target === "container" || target === "top" ? null : target;
    const after = childrenOf(index, parentId).at(-1)?.position ?? null;
    setFailed(null);
    try {
      const result = await writeImport(
        plan,
        {
          include,
          choices,
          parentId,
          after,
          containerTitle: target === "container" ? containerTitle.trim() || "Notion" : null,
          projectId: projectId || null,
          collectionId: collectionId || null,
          onProgress: progress,
        },
        state.current,
      );
      await pageActions.refresh();
      await invalidateVault();
      setStep({ kind: "done", result });
      toast.success(
        `Imported ${result.pages} pages`,
        result.items ? `${result.items} vault items created.` : undefined,
      );
    } catch (e) {
      setFailed(errorMessage(e));
      setStep({ kind: "preview" });
    }
  }

  const creds = showAllCreds ? includedCreds : includedCreds.slice(0, 100);

  return (
    <Page title="Import from Notion" crumbs={[{ label: "Pages", to: "/pages" }]}>
      <PageBody
        title="Import from Notion"
        subtitle="Bring your whole Notion workspace: pages inside pages, databases, images and files. Passwords and keys found in your pages become vault items. Everything is read and encrypted on this device."
      >
        {step.kind === "pick" && (
          <Section title="1. Export from Notion">
            <ol className="list-decimal space-y-1 ps-5 text-sm">
              <li>
                In Notion open <b>Settings → General → Export all workspace content</b> (or{" "}
                <b>⋯ → Export</b> on one page).
              </li>
              <li>
                Choose <b>Markdown &amp; CSV</b> (HTML works too), include <b>everything</b> and{" "}
                <b>files &amp; images</b>, and turn on <b>Create folders for subpages</b>.
              </li>
              <li>Drop the .zip here. Several parts of one export can be dropped together.</li>
            </ol>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void onFiles([...e.dataTransfer.files]);
              }}
              className={cn(
                "mt-3 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
                dragOver ? "border-primary bg-primary/5" : "border-border hover:bg-accent/40",
              )}
            >
              <FileArchive className="size-8 text-muted-foreground" />
              <span className="font-medium text-sm">Drop your Notion export here</span>
              <span className="text-muted-foreground text-xs">
                or click to choose the .zip file(s)
              </span>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => void onFiles([...(e.target.files ?? [])])}
              />
            </label>
            <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
              <ShieldCheck className="mt-px size-3.5 shrink-0 text-emerald-500" />
              Nothing is uploaded until you review and press Import. Afterwards, delete the export
              from your computer: it holds your pages in plain text.
            </p>
          </Section>
        )}

        {step.kind === "busy" && (
          <Section title={step.stage}>
            <div className="flex items-center gap-3 text-muted-foreground text-sm">
              <Progress
                value={step.total ? (step.done / step.total) * 100 : null}
                className="flex-1"
              >
                <ProgressTrack>
                  <ProgressIndicator />
                </ProgressTrack>
              </Progress>
              {step.total > 1 && (
                <span className="tabular-nums">
                  {step.done}/{step.total}
                </span>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              Keep this tab open. Large workspaces take a few minutes.
            </p>
          </Section>
        )}

        {step.kind === "preview" && plan && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Pages" value={plan.stats.pages} />
              <Stat
                label="Databases"
                value={plan.stats.databases}
                hint={`${plan.stats.rows} rows`}
              />
              <Stat
                label="Files & images"
                value={plan.stats.attachments}
                hint={formatBytes(plan.stats.attachmentBytes)}
              />
              <Stat label="Passwords & keys found" value={plan.credentials.length} />
            </div>

            {failed && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />
                <div className="flex-1">
                  The import stopped: {failed}. What was already stored stays; importing again
                  continues where it stopped.
                </div>
              </div>
            )}

            {(plan.exp.warnings.length > 0 || plan.stats.tooLarge.length > 0) && (
              <Section title="Heads up">
                {plan.exp.warnings.map((w) => (
                  <p key={w} className="text-sm">
                    {w}
                  </p>
                ))}
                {plan.stats.tooLarge.length > 0 && (
                  <p className="text-sm">
                    {plan.stats.tooLarge.length} file
                    {plan.stats.tooLarge.length === 1 ? " is" : "s are"} larger than{" "}
                    {MAX_ATTACHMENT / 1024 / 1024} MB and will be left out:{" "}
                    {plan.stats.tooLarge
                      .slice(0, 3)
                      .map((p) => p.split("/").pop())
                      .join(", ")}
                    {plan.stats.tooLarge.length > 3 ? "…" : ""}
                  </p>
                )}
              </Section>
            )}

            <Section title="2. Where it goes">
              <div className="grid gap-3 sm:grid-cols-2">
                <SimpleSelect value={target} onChange={setTarget} options={targetOptions} />
                {target === "container" && (
                  <Input
                    value={containerTitle}
                    onChange={(e) => setContainerTitle(e.target.value)}
                    placeholder="Page title"
                  />
                )}
              </div>
            </Section>

            <Section
              title={`3. Pages · ${includedPages} of ${plan.exp.nodes.size}`}
              hint="Untick anything you don't want. Unticking a page leaves out everything inside it."
              action={
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setIncludeState(new Set(plan.exp.nodes.keys()))}
                  >
                    All
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setIncludeState(new Set())}>
                    None
                  </Button>
                </div>
              }
            >
              <ul className="max-h-[28rem] overflow-y-auto">
                {plan.exp.roots.map((k) => (
                  <TreeNode
                    key={k}
                    exp={plan.exp}
                    nodeKey={k}
                    depth={0}
                    include={include}
                    setInclude={setInclude}
                    credCount={credCount}
                  />
                ))}
              </ul>
            </Section>

            {includedCreds.length > 0 && (
              <Section
                title={`4. Passwords and keys · ${toVault} to the vault`}
                hint="Each becomes a vault item, and the page shows a link to it instead of the secret. Turn one off to leave its text in the page."
                action={
                  <div className="flex gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        setChoices(
                          (m) => new Map([...m].map(([k, v]) => [k, { ...v, vault: true }])),
                        )
                      }
                    >
                      All to vault
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        setChoices(
                          (m) => new Map([...m].map(([k, v]) => [k, { ...v, vault: false }])),
                        )
                      }
                    >
                      Keep all as text
                    </Button>
                  </div>
                }
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <span className="text-muted-foreground text-xs">
                      Put the new items in project
                    </span>
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
                      options={(collections ?? []).map((c) => ({ value: c.id, label: c.name }))}
                    />
                  </div>
                </div>
                <div className="max-h-[28rem] overflow-y-auto">
                  {creds.map((c) => {
                    const choice = choices.get(c.id)!;
                    const set = (patch: Partial<CredentialChoice>) =>
                      setChoices((m) => new Map(m).set(c.id, { ...choice, ...patch }));
                    return (
                      <div
                        key={c.id}
                        className="flex flex-wrap items-center gap-2 border-border/60 border-b py-2 last:border-b-0"
                      >
                        <Switch
                          checked={choice.vault}
                          onCheckedChange={(v) => set({ vault: v })}
                          aria-label="Make a vault item"
                        />
                        <Input
                          size="sm"
                          className="w-48 min-w-0"
                          value={choice.name}
                          onChange={(e) => set({ name: e.target.value })}
                          disabled={!choice.vault}
                        />
                        <SimpleSelect
                          size="sm"
                          className="w-36 min-w-0"
                          value={choice.type}
                          onChange={(v) => set({ type: v })}
                          options={ITEM_TYPES.map((t) => ({ value: t.type, label: t.label }))}
                        />
                        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                          {describe(c)} · in “{plan.exp.nodes.get(c.nodeKey)?.title}”
                        </span>
                      </div>
                    );
                  })}
                </div>
                {includedCreds.length > creds.length && (
                  <Button size="xs" variant="ghost" onClick={() => setShowAllCreds(true)}>
                    Show all {includedCreds.length}
                  </Button>
                )}
              </Section>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep({ kind: "pick" })}>
                Start over
              </Button>
              <Button onClick={() => void run()} disabled={includedPages === 0}>
                {failed
                  ? "Continue import"
                  : `Encrypt & import ${includedPages} page${includedPages === 1 ? "" : "s"}`}
                {toVault ? ` and ${toVault} item${toVault === 1 ? "" : "s"}` : ""}
              </Button>
            </div>
          </>
        )}

        {step.kind === "done" && (
          <Section title="Imported">
            <p className="text-sm">
              {step.result.pages} pages, {step.result.items} vault items and {step.result.files}{" "}
              files are now encrypted in your vault.
            </p>
            {step.result.skippedFiles.length > 0 && (
              <p className="text-muted-foreground text-sm">
                Left out {step.result.skippedFiles.length} file(s) over{" "}
                {MAX_ATTACHMENT / 1024 / 1024} MB.
              </p>
            )}
            {step.result.failedItems > 0 && (
              <p className="text-muted-foreground text-sm">
                {step.result.failedItems} vault item(s) could not be created; their text was left in
                the page.
              </p>
            )}
            <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
              <ShieldCheck className="mt-px size-3.5 shrink-0 text-emerald-500" />
              Delete the export .zip from your computer now.
            </p>
            <div className="flex gap-2">
              {step.result.rootPageId && (
                <Button
                  onClick={() =>
                    void navigate({
                      to: "/pages/$pageId",
                      params: { pageId: step.result.rootPageId! },
                    })
                  }
                >
                  Open the imported pages
                </Button>
              )}
              {step.result.items > 0 && (
                <Button variant="outline" render={<Link to="/vault" />}>
                  See vault items
                </Button>
              )}
            </div>
          </Section>
        )}
      </PageBody>
    </Page>
  );
}
