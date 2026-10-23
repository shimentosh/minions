import type { PageKind, PageMeta } from "@minions/core";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/** A page as the app uses it: tree fields plus its decrypted meta. */
export interface PageEntry {
  id: string;
  parentId: string | null;
  position: string;
  kind: PageKind;
  favorite: boolean;
  revision: number;
  updatedAt: string;
  deletedAt: string | null;
  protectedKey: string;
  metaEnc: string;
  title: string;
  icon?: string;
  props?: PageMeta["props"];
}

export interface PageIndex {
  byId: Map<string, PageEntry>;
  /** Parent id ("" for the top level) → children in order. */
  children: Map<string, PageEntry[]>;
}

const order = (a: PageEntry, b: PageEntry) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1;

/** Groups pages by parent and orders siblings. Pages whose parent is missing go to the top. */
export function indexPages(pages: PageEntry[]): PageIndex {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const children = new Map<string, PageEntry[]>();
  for (const p of pages) {
    const parent = p.parentId && byId.has(p.parentId) ? p.parentId : "";
    const list = children.get(parent);
    if (list) list.push(p);
    else children.set(parent, [p]);
  }
  for (const list of children.values()) list.sort(order);
  return { byId, children };
}

export function childrenOf(index: PageIndex, id: string | null): PageEntry[] {
  return index.children.get(id ?? "") ?? [];
}

/** From the top level down to (not including) the page. */
export function ancestorsOf(index: PageIndex, id: string): PageEntry[] {
  const out: PageEntry[] = [];
  const seen = new Set<string>([id]);
  let cur = index.byId.get(id)?.parentId ?? null;
  while (cur && !seen.has(cur)) {
    const p = index.byId.get(cur);
    if (!p) break;
    out.unshift(p);
    seen.add(cur);
    cur = p.parentId;
  }
  return out;
}

/** Whether `id` is `ancestorId` or somewhere under it. */
export function isWithin(index: PageIndex, id: string, ancestorId: string): boolean {
  if (id === ancestorId) return true;
  return ancestorsOf(index, id).some((p) => p.id === ancestorId);
}

/** A position after every current child of `parentId`. */
export function positionAtEnd(index: PageIndex, parentId: string | null): string {
  const kids = childrenOf(index, parentId);
  return generateKeyBetween(kids.at(-1)?.position ?? null, null);
}

/** A position between two siblings (either may be missing). */
export function positionBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) return generateKeyBetween(before, null);
  return generateKeyBetween(before, after);
}

/** `n` ordered positions for new pages (imports). */
export function positions(n: number): string[] {
  return generateNKeysBetween(null, null, n);
}

/** Case- and accent-insensitive title match, for the sidebar filter and ⌘K. */
export function searchPages(pages: PageEntry[], query: string, limit = 50): PageEntry[] {
  // Decomposed accents are combining marks: dropping them makes "café" match "cafe".
  const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored: { p: PageEntry; score: number }[] = [];
  for (const p of pages) {
    const title = fold(p.title || "Untitled");
    if (!terms.every((t) => title.includes(t))) continue;
    scored.push({ p, score: title.startsWith(terms[0]!) ? 0 : 1 });
  }
  return scored
    .sort((a, b) => a.score - b.score || b.p.updatedAt.localeCompare(a.p.updatedAt))
    .slice(0, limit)
    .map((s) => s.p);
}

export const pageTitle = (p: Pick<PageEntry, "title"> | undefined) => p?.title.trim() || "Untitled";
