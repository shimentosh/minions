import type { PageContentsResponse } from "@minions/core";
import MiniSearch from "minisearch";
import { useEffect } from "react";
import { create } from "zustand";
import { post } from "../api";
import { onVaultClosed } from "../session";
import { decryptContent } from "./crypto";
import { fold, type PageEntry, pageTitle, searchPages } from "./tree";

/**
 * Full-text search over pages (docs/NOTION_ALTERNATIVE_PLAN.md §2 Search).
 * Bodies arrive encrypted, are decrypted here, and the index lives in memory
 * only: it is never written to browser storage and is dropped on lock. A page
 * is fetched again only when its revision changes.
 */

/** Indexed text per page is capped so one huge page cannot crowd out the rest. */
const MAX_BODY = 100_000;
const CHUNK = 100;

const BLOCK = new Set([
  "paragraph",
  "heading",
  "listItem",
  "taskItem",
  "blockquote",
  "codeBlock",
  "tableCell",
  "tableHeader",
  "detailsSummary",
  "hardBreak",
]);

/** The readable text of a ProseMirror document, one line per block. */
export function docText(doc: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as {
      type?: string;
      text?: string;
      attrs?: Record<string, unknown>;
      content?: unknown[];
    };
    if (typeof node.text === "string") out.push(node.text);
    else if (node.type === "vaultItem" && typeof node.attrs?.label === "string")
      out.push(node.attrs.label);
    else if (node.type === "pageFile" && typeof node.attrs?.name === "string")
      out.push(node.attrs.name);
    if (Array.isArray(node.content)) for (const c of node.content) walk(c);
    if (node.type && BLOCK.has(node.type)) out.push("\n");
  };
  walk(doc);
  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Database row values, so a row is found by what is in its columns. */
function propsText(p: PageEntry): string {
  if (!p.props) return "";
  return Object.values(p.props)
    .flatMap((v) => (Array.isArray(v) ? v : v === null || typeof v === "boolean" ? [] : [v]))
    .join(" ");
}

interface Doc {
  id: string;
  title: string;
  body: string;
}

const newIndex = () =>
  new MiniSearch<Doc>({
    fields: ["title", "body"],
    processTerm: (t) => fold(t) || null,
    searchOptions: {
      boost: { title: 3 },
      prefix: true,
      fuzzy: (term) => (term.length > 4 ? 0.2 : false),
      combineWith: "AND",
    },
  });

let index = newIndex();
const revisions = new Map<string, number>();
const bodies = new Map<string, string>();
/** Bumped on lock, so a build that was running when the vault closed stops writing. */
let generation = 0;
let running: Promise<void> | null = null;
let pending: PageEntry[] | null = null;

export const useSearchIndex = create<{ indexed: number; total: number; building: boolean }>(() => ({
  indexed: 0,
  total: 0,
  building: false,
}));

onVaultClosed(() => {
  generation++;
  index = newIndex();
  revisions.clear();
  bodies.clear();
  pending = null;
  useSearchIndex.setState({ indexed: 0, total: 0, building: false });
});

function put(doc: Doc, revision: number) {
  if (index.has(doc.id)) index.discard(doc.id);
  index.add(doc);
  revisions.set(doc.id, revision);
  bodies.set(doc.id, doc.body);
}

function drop(id: string) {
  if (index.has(id)) index.discard(id);
  revisions.delete(id);
  bodies.delete(id);
}

async function build(pages: PageEntry[]) {
  const gen = generation;
  const live = new Map(pages.map((p) => [p.id, p]));
  for (const id of [...revisions.keys()]) if (!live.has(id)) drop(id);
  const stale = pages.filter((p) => revisions.get(p.id) !== p.revision);
  useSearchIndex.setState({
    total: pages.length,
    indexed: pages.length - stale.length,
    building: stale.length > 0,
  });
  let queue = stale.map((p) => p.id);
  while (queue.length) {
    const ask = queue.slice(0, CHUNK);
    queue = queue.slice(CHUNK);
    let res: PageContentsResponse;
    try {
      res = await post<PageContentsResponse>("/pages/contents", { ids: ask });
    } catch {
      break; // Offline or locked: titles still search; the next sync tries again.
    }
    if (gen !== generation) return;
    queue = [...res.rest, ...queue];
    const done = await Promise.all(
      res.pages.map(async (r) => {
        const p = live.get(r.id)!;
        let body = "";
        try {
          const content = await decryptContent(p, r.contentEnc);
          body = content?.doc ? docText(content.doc) : "";
        } catch {
          // A page that cannot be decrypted is still found by its title.
        }
        body = [body, propsText(p)].filter(Boolean).join("\n").slice(0, MAX_BODY);
        // The title comes from the tree, which is at least as new as this body.
        return { doc: { id: r.id, title: pageTitle(p), body }, revision: r.revision };
      }),
    );
    if (gen !== generation) return;
    for (const d of done) put(d.doc, d.revision);
    // Pages that disappeared between the tree and this request.
    const got = new Set([...res.pages.map((r) => r.id), ...res.rest]);
    for (const id of ask) if (!got.has(id)) revisions.set(id, live.get(id)!.revision);
    useSearchIndex.setState((s) => ({ indexed: s.indexed + ask.length - res.rest.length }));
  }
  if (gen === generation) useSearchIndex.setState({ building: false });
}

/** Brings the index up to date with the tree. Calls during a build run once after it. */
export function syncSearchIndex(pages: PageEntry[]) {
  if (running) {
    pending = pages;
    return;
  }
  running = build(pages).finally(() => {
    running = null;
    const next = pending;
    pending = null;
    if (next) syncSearchIndex(next);
  });
}

/** Keeps the index fresh while a search box is open. */
export function usePageSearchIndex(pages: PageEntry[] | undefined, enabled: boolean) {
  useEffect(() => {
    if (enabled && pages) syncSearchIndex(pages);
  }, [enabled, pages]);
  return useSearchIndex();
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

/**
 * A short excerpt, on one line, around a word that matches one of `terms`:
 * the line that matches the most of them, and its first matching word.
 * `also` are the index's own matches (fuzzy: "fridya" found "friday"); they
 * are highlighted but do not count as extra words.
 */
export function snippetOf(
  body: string,
  terms: string[],
  also: string[] = [],
  width = 120,
): Snippet | null {
  const wanted = [...new Set(terms.map(fold).filter(Boolean))];
  const extra = new Set(also.map(fold));
  if (!wanted.length || !body) return null;
  // Written by settle(): typed so the checker does not assume it stays null.
  let best = null as { start: number; end: number; hits: number } | null;
  let first: { start: number; end: number } | null = null;
  let hits = new Set<number>();
  let lineBreak = -1;
  const settle = () => {
    if (first && (!best || hits.size > best.hits)) best = { ...first, hits: hits.size };
  };
  for (const m of body.matchAll(/[^\s\p{P}]+/gu)) {
    if (m.index > lineBreak) {
      // A new line: keep the old one if it was the best so far.
      settle();
      if (best && best.hits >= wanted.length) break;
      first = null;
      hits = new Set();
      lineBreak = body.indexOf("\n", m.index);
      if (lineBreak === -1) lineBreak = body.length;
    }
    const word = fold(m[0]);
    const found = wanted.flatMap((t, i) => (word.includes(t) ? [i] : []));
    if (!found.length && extra.has(word)) found.push(wanted.length);
    for (const i of found) hits.add(i);
    if (found.length) first ??= { start: m.index, end: m.index + m[0].length };
  }
  settle();
  if (!best) return null;
  const { start, end } = best;
  const lineStart = body.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = body.indexOf("\n", end) === -1 ? body.length : body.indexOf("\n", end);
  let from = Math.max(lineStart, start - 40);
  let to = Math.min(lineEnd, end + width);
  // Cut at spaces, not inside words.
  if (from > lineStart) {
    const space = body.indexOf(" ", from);
    if (space !== -1 && space < start) from = space + 1;
  }
  if (to < lineEnd) {
    const space = body.lastIndexOf(" ", to);
    if (space > end) to = space;
  }
  return {
    before: (from > lineStart ? "…" : "") + body.slice(from, start),
    match: body.slice(start, end),
    after: body.slice(end, to) + (to < lineEnd ? "…" : ""),
  };
}

export interface PageHit {
  page: PageEntry;
  /** Set when the words were found in the body rather than (only) the title. */
  snippet: Snippet | null;
}

/**
 * Title matches first (instant, even before the index is built), then pages
 * whose content matches. `pages` is what may be shown: archived pages are
 * already left out unless the person asked for them.
 */
export function searchAllPages(pages: PageEntry[], query: string, limit = 50): PageHit[] {
  const q = query.trim();
  if (!q) return [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const hits: PageHit[] = [];
  const seen = new Set<string>();
  const terms = q.split(/\s+/);
  for (const p of searchPages(pages, q, limit)) {
    seen.add(p.id);
    hits.push({ page: p, snippet: snippetOf(bodies.get(p.id) ?? "", terms) });
  }
  if (hits.length >= limit) return hits;
  for (const r of index.search(q, { filter: (r) => byId.has(r.id) && !seen.has(r.id) })) {
    const p = byId.get(r.id)!;
    hits.push({ page: p, snippet: snippetOf(bodies.get(r.id) ?? "", terms, r.terms) });
    if (hits.length >= limit) break;
  }
  return hits;
}
