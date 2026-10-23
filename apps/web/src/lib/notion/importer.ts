import type { DatabaseProperty, PageMeta, PagePropValue } from "@minions/core";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { post } from "../api";
import { buildNewPage, type PageContent, uploadPageFile } from "../pages/crypto";
import { encryptDraft } from "../vault-crypto";
import {
  convertPage,
  htmlBodyDoc,
  htmlLines,
  linkResolver,
  markdownLines,
  readHtmlDatabases,
} from "./convert";
import { type Credential, detectCredentials, detectRowCredential } from "./credentials";
import { analyzeExport, type NotionExport, type NotionNode } from "./parse";
import { readExport } from "./zip";

/**
 * The Notion import, end to end, on the device:
 *   read zips → build the tree → find credentials → (preview) → write.
 * Writing creates vault items for the credentials the person kept as items,
 * then pages parents-first in batches, then uploads attachments one by one,
 * everything encrypted before it is sent. A failed run can be retried with
 * the same state: pages and files already stored are skipped.
 */

export const MAX_ATTACHMENT = 25 * 1024 * 1024;
const BATCH_PAGES = 100;
const BATCH_BYTES = 2_000_000;

export interface ImportPlan {
  exp: NotionExport;
  credentials: Credential[];
  byNode: Map<string, Credential[]>;
  stats: {
    pages: number;
    databases: number;
    rows: number;
    attachments: number;
    attachmentBytes: number;
    tooLarge: string[];
  };
}

export type Progress = (stage: string, done: number, total: number) => void;

/** Reads the zips and prepares everything the preview shows. Nothing is sent. */
export async function planImport(files: Blob[], onProgress?: Progress): Promise<ImportPlan> {
  onProgress?.("Opening the export", 0, 1);
  const all = await readExport(files);
  const exp = await analyzeExport(all, (d, t) => onProgress?.("Reading pages", d, t));
  readHtmlDatabases(exp);

  let n = 0;
  const nextId = () => (n++).toString(36);
  const credentials: Credential[] = [];
  const byNode = new Map<string, Credential[]>();
  const nodes = [...exp.nodes.values()];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const found: Credential[] = [];
    const parent = node.parentKey ? exp.nodes.get(node.parentKey) : undefined;
    const db = parent ? exp.databases.get(parent.key) : undefined;
    if (node.row && db) {
      const c = detectRowCredential(node.row, db.columns, {
        nodeKey: node.key,
        title: node.title,
        nextId,
      });
      if (c) found.push(c);
    }
    if (node.text) {
      const lines =
        node.format === "html" ? htmlLines(htmlBodyDoc(node)).lines : markdownLines(node);
      found.push(...detectCredentials(lines, { nodeKey: node.key, title: node.title, nextId }));
    }
    if (found.length) {
      byNode.set(node.key, found);
      credentials.push(...found);
    }
    if (i % 100 === 0) {
      onProgress?.("Looking for passwords and keys", i, nodes.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const attachments = [...exp.files.entries()].filter(([p]) => !/\.(md|html|csv)$/i.test(p));
  return {
    exp,
    credentials,
    byNode,
    stats: {
      pages: nodes.filter((x) => x.kind === "page" && !x.row).length,
      databases: nodes.filter((x) => x.kind === "database").length,
      rows: nodes.filter((x) => x.row).length,
      attachments: attachments.length,
      attachmentBytes: attachments.reduce((s, [, f]) => s + f.size, 0),
      tooLarge: attachments.filter(([, f]) => f.size > MAX_ATTACHMENT).map(([p]) => p),
    },
  };
}

// ─── Databases ───────────────────────────────────────────────────────────────

/** Guesses a property type from a column's values. */
export function inferType(values: string[]): DatabaseProperty["type"] {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (!filled.length) return "text";
  if (filled.every((v) => /^-?\d+(?:[.,]\d+)?$/.test(v))) return "number";
  if (filled.every((v) => /^(yes|no)$/i.test(v))) return "checkbox";
  if (filled.every((v) => /^https?:\/\//i.test(v))) return "url";
  if (filled.every((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return "email";
  const distinct = new Set(filled);
  if (filled.some((v) => v.includes(", ")) && distinct.size < filled.length) return "multi_select";
  if (filled.length >= 4 && distinct.size <= 12 && distinct.size <= filled.length / 2)
    return "select";
  return "text";
}

export function databaseSchema(
  columns: string[],
  rows: Record<string, string>[],
  drop: Set<string>,
) {
  const properties: DatabaseProperty[] = columns.map((name, i) => {
    if (i === 0) return { id: "title", name, type: "title" };
    const type = inferType(rows.map((r) => r[name] ?? ""));
    const prop: DatabaseProperty = { id: `p${i}`, name, type };
    if (type === "select" || type === "multi_select")
      prop.options = [
        ...new Set(
          rows.flatMap((r) => (r[name] ?? "").split(", ").map((s) => s.trim())).filter(Boolean),
        ),
      ];
    return prop;
  });
  return { properties: properties.filter((p) => !drop.has(p.name)) };
}

function propValue(raw: string, type: DatabaseProperty["type"]): PagePropValue {
  const v = raw.trim();
  if (!v) return null;
  if (type === "number") return Number(v.replace(",", "."));
  if (type === "checkbox") return /^yes$/i.test(v);
  if (type === "multi_select")
    return v
      .split(", ")
      .map((s) => s.trim())
      .filter(Boolean);
  return v;
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export interface CredentialChoice {
  /** Make a vault item (true) or leave the text in the page (false). */
  vault: boolean;
  type: string;
  name: string;
}

export interface WriteOptions {
  include: Set<string>;
  choices: Map<string, CredentialChoice>;
  /** Where the import goes in Minions: under this page, or the top level. */
  parentId: string | null;
  /** A page that holds everything ("Notion"), or null to import at the target directly. */
  containerTitle: string | null;
  /** Position of the last existing page at the target, so the import lands after it. */
  after: string | null;
  projectId?: string | null;
  collectionId?: string | null;
  onProgress?: Progress;
}

/** Survives a failed run, so retrying skips what is already stored. */
export interface WriteState {
  pageIds: Map<string, string>;
  containerId?: string;
  itemIds: Map<string, string>;
  itemsDone: boolean;
  pagesDone: Set<string>;
  /** Attachments of stored pages: file id → where it goes and the page key. */
  files: Map<string, { pageId: string; path: string; key: Uint8Array<ArrayBuffer> }>;
  filesDone: Set<string>;
}

export const newWriteState = (): WriteState => ({
  pageIds: new Map(),
  itemIds: new Map(),
  itemsDone: false,
  pagesDone: new Set(),
  files: new Map(),
  filesDone: new Set(),
});

export interface WriteResult {
  rootPageId: string | null;
  pages: number;
  items: number;
  files: number;
  skippedFiles: string[];
  failedItems: number;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};
const mimeOf = (name: string) =>
  MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Parents before children, only what was chosen. */
function ordered(exp: NotionExport, include: Set<string>): NotionNode[] {
  const out: NotionNode[] = [];
  const visit = (key: string) => {
    const n = exp.nodes.get(key);
    if (!n || !include.has(key)) return;
    out.push(n);
    for (const c of n.children) visit(c);
  };
  for (const r of exp.roots) visit(r);
  return out;
}

async function createItems(plan: ImportPlan, opts: WriteOptions, state: WriteState) {
  const chosen = plan.credentials.filter(
    (c) =>
      opts.include.has(c.nodeKey) &&
      opts.choices.get(c.id)?.vault !== false &&
      !state.itemIds.has(c.id),
  );
  if (!chosen.length) return 0;
  const job = await post<{ id: string }>("/imports", {
    source: "notion",
    totalRecords: chosen.length,
    duplicateCount: 0,
    invalidCount: 0,
  });
  let failed = 0;
  for (let i = 0; i < chosen.length; i += 100) {
    const slice = chosen.slice(i, i + 100);
    const entries = [];
    const ids: string[] = [];
    for (const [k, c] of slice.entries()) {
      const choice = opts.choices.get(c.id);
      const id = crypto.randomUUID();
      ids.push(id);
      const page = plan.exp.nodes.get(c.nodeKey);
      const values = { ...c.values };
      const from = `Imported from the Notion page “${page?.title ?? "Untitled"}”.`;
      values.notes = values.notes ? `${values.notes}\n${from}` : from;
      entries.push({
        sourceRow: i + k,
        item: await encryptDraft({
          id,
          type: choice?.type ?? c.type,
          name: choice?.name || c.name,
          projectId: opts.projectId ?? null,
          collectionId: opts.collectionId ?? null,
          values,
        }),
      });
    }
    const res = await post<{ imported: number; failed: { sourceRow: number }[] }>(
      `/imports/${job.id}/items`,
      { entries },
    );
    const bad = new Set(res.failed.map((f) => f.sourceRow));
    failed += bad.size;
    slice.forEach((c, k) => {
      if (!bad.has(i + k)) state.itemIds.set(c.id, ids[k]!);
    });
    opts.onProgress?.("Creating vault items", Math.min(i + 100, chosen.length), chosen.length);
  }
  await post(`/imports/${job.id}/complete`, { skippedCount: 0 });
  return failed;
}

export async function writeImport(
  plan: ImportPlan,
  opts: WriteOptions,
  state: WriteState,
): Promise<WriteResult> {
  const { exp } = plan;
  const nodes = ordered(exp, opts.include);
  for (const n of nodes)
    if (!state.pageIds.has(n.key)) state.pageIds.set(n.key, crypto.randomUUID());

  // 1. Vault items, so pages can link to them.
  let failedItems = 0;
  if (!state.itemsDone) {
    failedItems = await createItems(plan, opts, state);
    state.itemsDone = failedItems === 0;
  }

  // 2. Pages, parents first, in batches.
  const resolve = linkResolver(exp, state.pageIds);
  let batch: unknown[] = [];
  let batchKeys: string[] = [];
  let bytes = 0;
  let created = 0;
  const flush = async () => {
    if (!batch.length) return;
    await post("/pages/batch", { pages: batch });
    // Only now are these pages stored; a failure before this retries them.
    for (const k of batchKeys) state.pagesDone.add(k);
    created += batch.length;
    batch = [];
    batchKeys = [];
    bytes = 0;
  };
  const queue = async (request: { id: string }, key: string) => {
    const size = JSON.stringify(request).length;
    if (batch.length >= BATCH_PAGES || bytes + size > BATCH_BYTES) await flush();
    batch.push(request);
    batchKeys.push(key);
    bytes += size;
  };

  const roots = exp.roots.filter((k) => opts.include.has(k));
  if (opts.containerTitle && !state.containerId) {
    const { request } = await buildNewPage({
      parentId: opts.parentId,
      position: generateKeyBetween(opts.after, null),
      meta: { title: opts.containerTitle, icon: "📥" },
    });
    await post("/pages/batch", { pages: [request] });
    state.containerId = request.id;
  }
  const top = state.containerId ?? opts.parentId;

  // Siblings keep their order; keys are generated per parent.
  const posOf = new Map<string, string>();
  const place = (keys: string[], after: string | null) => {
    const ps = generateNKeysBetween(after, null, keys.length);
    for (const [i, k] of keys.entries()) posOf.set(k, ps[i]!);
  };
  place(roots, state.containerId ? null : opts.after);
  for (const n of nodes)
    place(
      n.children.filter((k) => opts.include.has(k)),
      null,
    );

  for (const [i, node] of nodes.entries()) {
    if (state.pagesDone.has(node.key)) continue;
    const id = state.pageIds.get(node.key)!;
    const parentNode = node.parentKey ? exp.nodes.get(node.parentKey) : undefined;
    const parentId =
      parentNode && opts.include.has(parentNode.key) ? state.pageIds.get(parentNode.key)! : top;
    const creds = plan.byNode.get(node.key) ?? [];
    const vaultCreds = creds.filter(
      (c) => opts.choices.get(c.id)?.vault !== false && state.itemIds.has(c.id),
    );
    const vaultItems = new Map(
      creds.map((c) => [
        c.id,
        state.itemIds.has(c.id)
          ? { itemId: state.itemIds.get(c.id)!, label: opts.choices.get(c.id)?.name || c.name }
          : null,
      ]),
    );

    const meta: PageMeta = { title: node.title };
    const icon =
      node.format === "html"
        ? node.text?.match(
            /class="page-header-icon[^"]*">\s*<span class="icon">([^<]{1,8})<\/span>/,
          )?.[1]
        : undefined;
    if (icon) meta.icon = icon;
    let content: PageContent | null = null;

    const db = exp.databases.get(node.key);
    if (node.kind === "database" && db) {
      const rows = node.children
        .map((k) => exp.nodes.get(k)?.row)
        .filter((r): r is Record<string, string> => !!r);
      const drop = new Set(
        node.children.flatMap((k) =>
          (plan.byNode.get(k) ?? [])
            .filter((c) => c.source === "row" && opts.choices.get(c.id)?.vault !== false)
            .flatMap((c) => c.secretColumns ?? []),
        ),
      );
      content = { v: 1, schema: databaseSchema(db.columns, rows, drop) };
    }

    const parentDb = parentNode ? exp.databases.get(parentNode.key) : undefined;
    if (node.row && parentDb) {
      const rows = parentNode!.children
        .map((k) => exp.nodes.get(k)?.row)
        .filter((r): r is Record<string, string> => !!r);
      const rowCred = creds.find((c) => c.source === "row");
      const drop = new Set(
        rowCred && vaultItems.get(rowCred.id) ? (rowCred.secretColumns ?? []) : [],
      );
      const schema = databaseSchema(parentDb.columns, rows, new Set());
      const props: Record<string, PagePropValue> = {};
      for (const p of schema.properties) {
        if (p.type === "title" || drop.has(p.name)) continue;
        const v = propValue(node.row[p.name] ?? "", p.type);
        if (v !== null) props[p.id] = v;
      }
      meta.props = props;
    }

    if (node.kind !== "database" || node.text) {
      const fileIds = new Map<string, string>();
      let doc = node.text
        ? convertPage(
            node,
            { redact: vaultCreds.filter((c) => c.source !== "row") },
            {
              node,
              resolve,
              vaultItems,
              fileIdFor: (path) => {
                let f = fileIds.get(path);
                if (!f) {
                  f = crypto.randomUUID();
                  fileIds.set(path, f);
                }
                return f;
              },
            },
          )
        : { type: "doc", content: [{ type: "paragraph" }] };
      // A database row whose secrets went to the vault starts with a link to the item.
      const rowCred = creds.find((c) => c.source === "row");
      const rowItem = rowCred ? vaultItems.get(rowCred.id) : null;
      if (rowItem) {
        const d = doc as { content?: unknown[] };
        d.content = [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "🔑 " },
              { type: "vaultItem", attrs: { itemId: rowItem.itemId, label: rowItem.label } },
            ],
          },
          ...(d.content ?? []),
        ];
        doc = d;
      }
      if (node.kind !== "database") content = { v: 1, doc };
      const { request, key } = await buildNewPage({
        id,
        parentId,
        position: posOf.get(node.key) ?? "a0",
        kind: node.kind,
        meta,
        content,
      });
      for (const [path, fileId] of fileIds) state.files.set(fileId, { pageId: id, path, key });
      await queue(request, node.key);
    } else {
      const { request } = await buildNewPage({
        id,
        parentId,
        position: posOf.get(node.key) ?? "a0",
        kind: node.kind,
        meta,
        content,
      });
      await queue(request, node.key);
    }
    if (i % 20 === 0) {
      opts.onProgress?.("Encrypting pages", i, nodes.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  await flush();
  opts.onProgress?.("Encrypting pages", nodes.length, nodes.length);

  // 3. Attachments, a few at a time.
  const skippedFiles: string[] = [];
  let uploaded = 0;
  const todo = [...state.files.entries()]
    .filter(([fileId]) => !state.filesDone.has(fileId))
    .map(([fileId, f]) => ({ fileId, ...f }));
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const f = todo[next++]!;
      const file = exp.files.get(f.path);
      if (!file || file.size > MAX_ATTACHMENT) {
        skippedFiles.push(f.path);
        continue;
      }
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      await uploadPageFile(
        f.pageId,
        f.key,
        await file.bytes(),
        { name, type: mimeOf(name) },
        f.fileId,
      );
      state.filesDone.add(f.fileId);
      uploaded++;
      opts.onProgress?.("Encrypting files", uploaded + skippedFiles.length, todo.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  return {
    rootPageId: state.containerId ?? (roots[0] ? (state.pageIds.get(roots[0]) ?? null) : null),
    pages: created,
    items: state.itemIds.size,
    files: uploaded,
    skippedFiles,
    failedItems,
  };
}
