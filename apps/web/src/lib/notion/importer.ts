import type { DatabaseProperty, PageMeta, PagePropValue, UpsertItemRequest } from "@minions/core";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { ApiError, post } from "../api";
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
import {
  type Credential,
  dedupeKey,
  detectCredentials,
  detectRowCredential,
  groupOf,
} from "./credentials";
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
    /** Finds that are another find again (same secret, account and place). */
    duplicates: number;
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

  // The same secret for the same account, written on several pages, is one item.
  // The first find leads; what the others add (a URL, a username) fills it in.
  const leaders = new Map<string, Credential>();
  for (const c of credentials) {
    const key = dedupeKey(c);
    const lead = leaders.get(key);
    if (!lead) {
      leaders.set(key, c);
      continue;
    }
    c.duplicateOf = lead.id;
    for (const [k, v] of Object.entries(c.values)) if (!lead.values[k]) lead.values[k] = v;
  }

  const attachments = [...exp.files.entries()].filter(([p]) => !/\.(md|html|csv)$/i.test(p));
  return {
    exp,
    credentials,
    byNode,
    stats: {
      duplicates: credentials.filter((c) => c.duplicateOf).length,
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

/** Rate limits, server hiccups and dropped connections: worth another try. */
const transient = (e: unknown) =>
  e instanceof ApiError && (e.status === 0 || e.status === 429 || e.status >= 500);

/**
 * Large imports send thousands of requests and can meet the API's rate
 * limit. Waits and tries again (1, 2, 4… up to 30 s), a few times.
 */
export async function retrying<T>(
  run: () => Promise<T>,
  retry: (e: unknown) => boolean,
  attempts = 6,
  wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i + 1 >= attempts || !retry(e)) throw e;
      await wait(Math.min(1000 * 2 ** i, 30_000));
    }
  }
}

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
  /**
   * Archive what the import creates (default): pages and items stay out of
   * the tree, lists and search until shown or unarchived.
   */
  archive?: boolean;
  onProgress?: Progress;
}

/** Items made by an import carry this tag, so they can be found together. */
export const NOTION_IMPORT_TAG = "notion-import";

/** "Workspace / Projects / Acme": where a page sat in Notion. */
export function notionPath(exp: NotionExport, key: string): string {
  const titles: string[] = [];
  for (let n = exp.nodes.get(key); n; n = n.parentKey ? exp.nodes.get(n.parentKey) : undefined)
    titles.unshift(n.title || "Untitled");
  return titles.join(" / ");
}

/** Survives a failed run, so retrying skips what is already stored. */
export interface WriteState {
  pageIds: Map<string, string>;
  containerId?: string;
  /** Credential (groupOf) → the vault item made for it. */
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

/** Whether a find becomes (or links to) a vault item. */
const toVault = (c: Credential, opts: WriteOptions) =>
  opts.include.has(c.nodeKey) && opts.choices.get(groupOf(c))?.vault !== false;

async function createItems(plan: ImportPlan, opts: WriteOptions, state: WriteState) {
  // One item per credential: the first imported find of each makes it.
  const wanted = plan.credentials.filter((c) => toVault(c, opts));
  const members = new Map<string, Credential[]>();
  for (const c of wanted) members.set(groupOf(c), [...(members.get(groupOf(c)) ?? []), c]);
  const chosen = [...members.entries()]
    .filter(([g]) => !state.itemIds.has(g))
    .map(([, list]) => list[0]!);
  if (!chosen.length) return 0;
  const archive = opts.archive !== false;
  const job = await post<{ id: string }>("/imports", {
    source: "notion",
    totalRecords: chosen.length,
    duplicateCount: 0,
    invalidCount: 0,
  });
  let failed = 0;
  for (let i = 0; i < chosen.length; i += 100) {
    const slice = chosen.slice(i, i + 100);
    const entries: { sourceRow: number; item: UpsertItemRequest }[] = [];
    const ids: string[] = [];
    for (const [k, c] of slice.entries()) {
      const choice = opts.choices.get(groupOf(c));
      const id = crypto.randomUUID();
      ids.push(id);
      const values = { ...c.values };
      // Where it was written, encrypted with the item: the notes are a sensitive field.
      const paths = [
        ...new Set((members.get(groupOf(c)) ?? [c]).map((m) => notionPath(plan.exp, m.nodeKey))),
      ];
      const from =
        paths.length > 1
          ? `Imported from Notion, found on ${paths.length} pages:\n${paths.map((p) => `• ${p}`).join("\n")}`
          : `Imported from Notion: ${paths[0]}`;
      values.notes = values.notes ? `${values.notes}\n\n${from}` : from;
      const item = await encryptDraft({
        id,
        type: choice?.type ?? c.type,
        name: choice?.name || c.name,
        projectId: opts.projectId ?? null,
        collectionId: opts.collectionId ?? null,
        tags: [NOTION_IMPORT_TAG],
        values,
      });
      entries.push({ sourceRow: i + k, item: archive ? { ...item, archived: true } : item });
    }
    // Only a rate limit is retried: after any other failure the items may exist.
    const res = await retrying(
      () =>
        post<{ imported: number; failed: { sourceRow: number }[] }>(`/imports/${job.id}/items`, {
          entries,
        }),
      (e) => e instanceof ApiError && e.status === 429,
    );
    const bad = new Set(res.failed.map((f) => f.sourceRow));
    failed += bad.size;
    slice.forEach((c, k) => {
      if (!bad.has(i + k)) state.itemIds.set(groupOf(c), ids[k]!);
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
    // Safe to repeat: pages already stored are skipped.
    await retrying(() => post("/pages/batch", { pages: batch }), transient);
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

  // Every page made here is archived (unless asked not to) and knows it was imported;
  // the marker is inside the encrypted meta, the archived flag is all the server sees.
  const archived = opts.archive !== false;
  const imported = { from: "notion", at: new Date().toISOString() };
  const roots = exp.roots.filter((k) => opts.include.has(k));
  if (opts.containerTitle && !state.containerId) {
    const { request } = await buildNewPage({
      parentId: opts.parentId,
      position: generateKeyBetween(opts.after, null),
      meta: { title: opts.containerTitle, icon: "📥", imported },
      archived,
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
    const itemOf = (c: Credential) =>
      toVault(c, opts) ? state.itemIds.get(groupOf(c)) : undefined;
    const vaultCreds = creds.filter((c) => itemOf(c));
    const vaultItems = new Map(
      creds.map((c) => {
        const itemId = itemOf(c);
        const label = opts.choices.get(groupOf(c))?.name || c.name;
        return [c.id, itemId ? { itemId, label } : null];
      }),
    );

    const meta: PageMeta = { title: node.title, imported };
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
            .filter((c) => c.source === "row" && opts.choices.get(groupOf(c))?.vault !== false)
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
        archived,
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
        archived,
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
      const bytes = await file.bytes();
      // Safe to repeat: the same file id is stored once.
      await retrying(
        () => uploadPageFile(f.pageId, f.key, bytes, { name, type: mimeOf(name) }, f.fileId),
        transient,
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
