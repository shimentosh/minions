import { csvToObjects, parseCsv } from "@minions/core";
import type { ExportFile } from "./zip";

/**
 * Turns the files of a Notion export (Markdown & CSV, or HTML) into a tree
 * of pages and databases. Pure: no DOM, no network, nothing leaves the tab.
 *
 * Notion names every page `<Title> <32 hex id>.<md|html>` and puts its
 * sub-pages in a folder with the same name. A database is
 * `<Title> <id>.csv` (newer exports also `<Title> <id>_all.csv`, which wins)
 * with one page per row in its folder. Attachments sit next to the page
 * that links them.
 */

export type NodeKind = "page" | "database";

export interface NotionNode {
  key: string;
  notionId: string | null;
  title: string;
  kind: NodeKind;
  parentKey: string | null;
  /** The page's own file (md or html); a database from a CSV-only export has none. */
  file?: ExportFile;
  format?: "md" | "html";
  /** Raw text of `file`, read during analysis. */
  text?: string;
  /** Databases: the CSV. */
  csv?: ExportFile;
  /** Folder of the page file: relative links resolve from here. */
  dir: string;
  /** Database rows: column name → raw value. */
  row?: Record<string, string>;
  /** Database rows: position in the CSV. */
  rowIndex?: number;
  children: string[];
}

export interface NotionDatabase {
  key: string;
  columns: string[];
}

export interface NotionExport {
  nodes: Map<string, NotionNode>;
  roots: string[];
  databases: Map<string, NotionDatabase>;
  /** Every file by its normalized path, for links and attachments. */
  files: Map<string, ExportFile>;
  /** Notion id → node key. */
  byNotionId: Map<string, string>;
  warnings: string[];
}

const ID_NAME = /^(.*?)\s+([0-9a-f]{32})$/i;
const PAGE_EXT = /\.(md|html)$/i;

export const normalizePath = (p: string) => p.normalize("NFC").replace(/^\.?\/+/, "");

export function dirname(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** "Projects 1a2b…(32)" → {title, id}; names without an id keep their name. */
export function splitName(name: string): { title: string; id: string | null } {
  const m = name.match(ID_NAME);
  return m ? { title: m[1]!.trim(), id: m[2]!.toLowerCase() } : { title: name.trim(), id: null };
}

/** Resolves a relative link from a folder, decoding %20 and friends. */
export function resolvePath(fromDir: string, href: string): string | null {
  let target: string;
  try {
    target = decodeURIComponent(href.split("#")[0]!.split("?")[0]!);
  } catch {
    target = href;
  }
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const parts = (target.startsWith("/") ? [] : fromDir.split("/").filter(Boolean)).concat(
    target.split("/"),
  );
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return normalizePath(out.join("/"));
}

/** The Notion page id a link points at: a path in the export or a notion.so URL. */
export function notionIdIn(href: string): string | null {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {}
  const m = decoded.match(/([0-9a-f]{32})(?:\.(?:md|html|csv))?(?:[?#].*)?$/i);
  if (m) return m[1]!.toLowerCase();
  const dashed = decoded.match(
    /([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})(?:[?#].*)?$/i,
  );
  return dashed ? dashed.slice(1).join("").toLowerCase() : null;
}

const firstColumn = (text: string) => parseCsv(text.replace(/^﻿/, ""))[0] ?? [];

/**
 * Builds the tree. Reads every page and CSV text (small); attachments are
 * left in the zip until they are written.
 */
export async function analyzeExport(
  all: ExportFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<NotionExport> {
  const files = new Map<string, ExportFile>();
  for (const f of all) files.set(normalizePath(f.path), f);
  const nodes = new Map<string, NotionNode>();
  const byNotionId = new Map<string, string>();
  const warnings: string[] = [];
  /** Folder path → the node whose sub-pages it holds. */
  const folderOwner = new Map<string, string>();
  /**
   * Newer exports name sub-page folders by title alone ("Projects/"), some by
   * the id alone. Used when no "<Title> <id>" folder matches; a title two
   * siblings share (null) is not guessed.
   */
  const looseOwner = new Map<string, string | null>();
  const claim = (folder: string, key: string) => {
    const had = looseOwner.get(folder);
    looseOwner.set(folder, had === undefined || had === key ? key : null);
  };
  const claimLoose = (dir: string, title: string, id: string | null, key: string) => {
    const prefix = dir ? `${dir}/` : "";
    if (title) claim(`${prefix}${title}`, key);
    if (id) claim(`${prefix}${id}`, key);
  };

  const csvs = [...files.entries()].filter(([p]) => /\.csv$/i.test(p));
  const pageFiles = [...files.entries()].filter(([p]) => PAGE_EXT.test(p));
  const total = csvs.length + pageFiles.length;
  let done = 0;
  const tick = () => {
    done++;
    if (done % 25 === 0 || done === total) onProgress?.(done, total);
  };

  const nodeFor = (id: string | null, key: string, title: string, dir: string): NotionNode => {
    const existing = nodes.get(key);
    if (existing) return existing;
    const node: NotionNode = {
      key,
      notionId: id,
      title,
      kind: "page",
      parentKey: null,
      dir,
      children: [],
    };
    nodes.set(key, node);
    if (id) byNotionId.set(id, key);
    return node;
  };

  // Databases first: "<Title> <id>.csv" and "<Title> <id>_all.csv" (the full one wins).
  for (const [path, file] of csvs) {
    const name = basename(path).replace(/\.csv$/i, "");
    const all = /_all$/i.test(name);
    const { title, id } = splitName(name.replace(/_all$/i, ""));
    const key = id ?? `path:${path}`;
    const node = nodeFor(id, key, title, dirname(path));
    node.kind = "database";
    if (!node.csv || all) node.csv = file;
    folderOwner.set(
      `${dirname(path) ? `${dirname(path)}/` : ""}${name.replace(/_all$/i, "")}`,
      key,
    );
    claimLoose(dirname(path), title, id, key);
    tick();
  }

  for (const [path, file] of pageFiles) {
    const name = basename(path).replace(PAGE_EXT, "");
    const { title, id } = splitName(name);
    // The workspace HTML export's own table of contents.
    if (!id && /^index$/i.test(name) && !dirname(path)) {
      tick();
      continue;
    }
    const key = id ?? `path:${path}`;
    const node = nodeFor(id, key, title, dirname(path));
    node.file = file;
    node.format = /\.html$/i.test(path) ? "html" : "md";
    node.dir = dirname(path);
    node.text = await file.text();
    folderOwner.set(path.replace(PAGE_EXT, ""), key);
    claimLoose(dirname(path), title, id, key);
    tick();
  }

  // Parents: the nearest folder that belongs to a page or database.
  for (const node of nodes.values()) {
    let dir = node.dir;
    while (dir) {
      const owner = folderOwner.get(dir) ?? looseOwner.get(dir);
      if (owner && owner !== node.key) {
        node.parentKey = owner;
        break;
      }
      dir = dirname(dir);
    }
  }

  // Database rows: match CSV rows to row pages by title, in order.
  const databases = new Map<string, NotionDatabase>();
  for (const db of [...nodes.values()].filter((n) => n.kind === "database")) {
    if (!db.csv) continue;
    let rows: Record<string, string>[];
    let columns: string[];
    try {
      const text = await db.csv.text();
      columns = firstColumn(text).map((c) => c.trim());
      rows = csvToObjects(text.replace(/^﻿/, ""));
    } catch {
      warnings.push(`Couldn't read the table of "${db.title}"; its rows are imported as pages.`);
      continue;
    }
    databases.set(db.key, { key: db.key, columns });
    const titleCol = columns[0] ?? "Name";
    const pages = [...nodes.values()].filter((n) => n.parentKey === db.key);
    const matches = matchRows(
      rows.map((r) => (r[titleCol] ?? "").trim()),
      pages,
    );
    rows.forEach((row, i) => {
      const title = (row[titleCol] ?? "").trim();
      const match = matches[i];
      if (match) {
        match.row = row;
        match.rowIndex = i;
      } else {
        // A row without its own page in the export: it still becomes a page.
        const node = nodeFor(null, `${db.key}:row:${i}`, title || "Untitled", db.dir);
        node.parentKey = db.key;
        node.row = row;
        node.rowIndex = i;
      }
    });
  }

  // Children, ordered as the parent's text first mentions them, then by title.
  for (const node of nodes.values()) {
    if (node.parentKey && nodes.has(node.parentKey))
      nodes.get(node.parentKey)!.children.push(node.key);
    else node.parentKey = null;
  }
  for (const node of nodes.values()) {
    const text = node.text ?? "";
    const rank = (k: string) => {
      const c = nodes.get(k)!;
      const at = c.notionId ? text.indexOf(c.notionId) : -1;
      return at < 0 ? Number.MAX_SAFE_INTEGER : at;
    };
    const rowAt = (k: string) => nodes.get(k)!.rowIndex ?? Number.MAX_SAFE_INTEGER;
    node.children.sort((a, b) =>
      // Database rows keep the CSV's order.
      node.kind === "database"
        ? rowAt(a) - rowAt(b)
        : rank(a) - rank(b) || nodes.get(a)!.title.localeCompare(nodes.get(b)!.title),
    );
  }

  const roots = [...nodes.values()]
    .filter((n) => !n.parentKey)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((n) => n.key);
  if (!nodes.size)
    warnings.push("No Notion pages were found. Export as “Markdown & CSV” or “HTML”.");
  return { nodes, roots, databases, files, byNotionId, warnings };
}

const loose = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Pairs CSV rows with the row pages in a database folder. File names are the
 * title with some characters dropped or replaced, cut short when long, and
 * "Untitled" when empty, so after exact titles come titles compared without
 * case and punctuation, then by prefix, then untitled rows. Order is kept.
 */
export function matchRows(titles: string[], pages: NotionNode[]): (NotionNode | undefined)[] {
  const out: (NotionNode | undefined)[] = titles.map(() => undefined);
  const left = new Set(pages);
  const pass = (same: (title: string, page: NotionNode) => boolean) => {
    titles.forEach((t, i) => {
      if (out[i]) return;
      for (const p of left)
        if (same(t, p)) {
          out[i] = p;
          left.delete(p);
          return;
        }
    });
  };
  pass((t, p) => t === p.title);
  pass((t, p) => !!loose(t) && loose(t) === loose(p.title));
  pass((t, p) => {
    const a = loose(t);
    const b = loose(p.title);
    return Math.min(a.length, b.length) >= 6 && (a.startsWith(b) || b.startsWith(a));
  });
  pass((t, p) => !loose(t) && (!p.title || /^untitled$/i.test(p.title)));
  return out;
}

/** Every node under (and including) `key`. */
export function subtreeKeys(exp: NotionExport, key: string): string[] {
  const out: string[] = [];
  const stack = [key];
  while (stack.length) {
    const k = stack.pop()!;
    out.push(k);
    const n = exp.nodes.get(k);
    if (n) stack.push(...n.children);
  }
  return out;
}

/** Strips Notion's leading "# Title" and, for database rows, the property lines under it. */
export function markdownBody(node: NotionNode): string {
  const lines = (node.text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (lines[i]?.startsWith("# ")) i++;
  if (node.row) {
    // "Property: value" lines right after the title.
    let j = i;
    while (j < lines.length && !lines[j]!.trim()) j++;
    let k = j;
    while (k < lines.length && /^[^:\n]{1,80}:\s/.test(lines[k]!)) k++;
    if (k > j) i = k;
  }
  return lines.slice(i).join("\n");
}
