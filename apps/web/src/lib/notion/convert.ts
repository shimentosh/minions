import { generateJSON } from "@tiptap/core";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { pageSchema } from "../pages/schema";
import { type Credential, redactLines, TOKEN_RE, tokenFor, unescapeMd } from "./credentials";
import { markdownBody, type NotionExport, type NotionNode, notionIdIn, resolvePath } from "./parse";

/**
 * Notion Markdown or HTML → the page schema's JSON. Everything is parsed in
 * an inert DOMParser document (no scripts run, nothing loads), sanitised by
 * DOMPurify, and finally passed through the editor schema, which keeps only
 * the nodes Minions knows. Links to other exported pages become page links;
 * images and files become encrypted attachments; secrets that became vault
 * items become item chips.
 */

export type LinkTarget =
  | { kind: "page"; pageId: string }
  | { kind: "file"; path: string; name: string; size: number }
  | { kind: "external"; href: string }
  | { kind: "none" };

export interface ConvertContext {
  node: NotionNode;
  resolve: (href: string, node: NotionNode) => LinkTarget;
  /** A stable file id for an attachment path in this page. */
  fileIdFor: (path: string) => string;
  /** Credentials taken out of this page: id → vault item id (null: keep the text). */
  vaultItems: Map<string, { itemId: string; label: string } | null>;
}

let schema: ReturnType<typeof pageSchema> | null = null;
const extensions = () => (schema ??= pageSchema());

const parseHtml = (html: string) => new DOMParser().parseFromString(html, "text/html");

const EMOJI = /^\s*(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/u;

function el(doc: Document, tag: string, attrs: Record<string, string> = {}) {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Rewrites Notion's markup into the schema's (callouts, to-dos, toggles, images, links). */
function normalize(doc: Document, ctx: ConvertContext) {
  const root = doc.body;

  // Callouts: <figure class="callout"><div><span class="icon">💡</span></div><div>…</div></figure> (HTML)
  // and <aside>💡 text</aside> (Markdown).
  for (const fig of [...root.querySelectorAll("figure.callout, aside")]) {
    const iconEl = fig.querySelector(".icon");
    let icon = iconEl?.textContent?.trim() || "";
    if (iconEl) iconEl.closest("div")?.remove();
    const callout = el(doc, "div", { "data-callout": "" });
    const content = fig.querySelector(":scope > div[style*='width']") ?? fig;
    while (content.firstChild) callout.appendChild(content.firstChild);
    if (!icon) {
      const first = callout.firstChild;
      if (first?.nodeType === Node.TEXT_NODE) {
        const m = first.textContent?.match(EMOJI);
        if (m) {
          icon = m[1]!;
          first.textContent = first.textContent!.slice(m[0].length);
        }
      }
    }
    callout.setAttribute("data-icon", icon || "💡");
    // Loose text in a callout needs a paragraph.
    if (
      [...callout.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
    ) {
      const p = el(doc, "p");
      while (callout.firstChild) p.appendChild(callout.firstChild);
      callout.appendChild(p);
    }
    fig.replaceWith(callout);
  }

  // To-dos. HTML: <ul class="to-do-list"><li><div class="checkbox checkbox-on"></div><span>…</span></li>
  for (const ul of [...root.querySelectorAll("ul.to-do-list")]) {
    ul.setAttribute("data-type", "taskList");
    for (const li of [...ul.querySelectorAll(":scope > li")]) {
      const on = !!li.querySelector(".checkbox-on");
      li.querySelector(".checkbox")?.remove();
      li.setAttribute("data-type", "taskItem");
      li.setAttribute("data-checked", String(on));
      const p = el(doc, "p");
      while (li.firstChild) p.appendChild(li.firstChild);
      li.appendChild(p);
    }
  }
  // Markdown (GFM): <li><input type="checkbox" checked> text</li>
  for (const input of [
    ...root.querySelectorAll("li > input[type=checkbox], li > p > input[type=checkbox]"),
  ]) {
    const li = input.closest("li")!;
    const ul = li.parentElement;
    if (ul) ul.setAttribute("data-type", "taskList");
    li.setAttribute("data-type", "taskItem");
    li.setAttribute("data-checked", String(input.hasAttribute("checked")));
    input.remove();
    if (!li.querySelector(":scope > p")) {
      const p = el(doc, "p");
      for (const n of [...li.childNodes]) {
        if (n.nodeType === Node.ELEMENT_NODE && /^(UL|OL)$/.test((n as Element).tagName)) break;
        p.appendChild(n);
      }
      li.prepend(p);
    }
  }

  // Toggles: <details><summary>…</summary>…</details> needs a content wrapper.
  for (const details of [...root.querySelectorAll("details")]) {
    const summary = details.querySelector(":scope > summary") ?? el(doc, "summary");
    const content = el(doc, "div", { "data-type": "detailsContent" });
    for (const n of [...details.childNodes]) if (n !== summary) content.appendChild(n);
    if (!content.childNodes.length) content.appendChild(el(doc, "p"));
    details.replaceChildren(summary, content);
    details.setAttribute("open", "");
    // Notion wraps toggles in a list item.
    const li = details.parentElement;
    if (
      li?.tagName === "LI" &&
      li.childElementCount === 1 &&
      li.parentElement?.classList.contains("toggle")
    ) {
      li.parentElement.replaceWith(details);
    }
  }

  // Images: exported files become attachments; remote images become links.
  for (const img of [...root.querySelectorAll("img")]) {
    const src = img.getAttribute("src") ?? "";
    const target = ctx.resolve(src, ctx.node);
    const holder = img.closest("figure.image") ?? img;
    if (target.kind === "file") {
      holder.replaceWith(
        el(doc, "img", {
          "data-file-id": ctx.fileIdFor(target.path),
          alt: img.getAttribute("alt") ?? target.name,
        }),
      );
    } else if (target.kind === "external") {
      const a = el(doc, "a", { href: target.href });
      a.textContent = img.getAttribute("alt") || "Image";
      const p = el(doc, "p");
      p.appendChild(a);
      holder.replaceWith(p);
    } else holder.remove();
  }

  // Links: pages → page links, exported files → attachments, the web stays a link.
  for (const a of [...root.querySelectorAll("a[href]")]) {
    const href = a.getAttribute("href") ?? "";
    const target = ctx.resolve(href, ctx.node);
    if (target.kind === "page") {
      a.replaceWith(el(doc, "span", { "data-page-id": target.pageId }));
    } else if (target.kind === "file") {
      const block = el(doc, "div", {
        "data-page-file": "",
        "data-file-id": ctx.fileIdFor(target.path),
        "data-name": target.name,
        "data-size": String(target.size),
      });
      // Attachments are blocks: lift them out of their paragraph.
      const host = a.closest("p, li, h1, h2, h3, td") ?? a;
      host.after(block);
      a.remove();
      if (host !== a && !host.textContent?.trim() && !host.querySelector("img, span[data-page-id]"))
        host.remove();
    } else if (target.kind === "external") {
      a.setAttribute("href", target.href);
      a.removeAttribute("target");
    } else {
      a.replaceWith(...a.childNodes);
    }
  }

  // Notion's chrome around the content.
  for (const x of [
    ...root.querySelectorAll("header, .page-title, table.properties, style, script"),
  ])
    x.remove();
}

/** Vault-item tokens in text → item chips (or back to text when the person kept it). */
function placeVaultItems(doc: Document, ctx: ConvertContext) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    TOKEN_RE.lastIndex = 0;
    if (TOKEN_RE.test(n.textContent ?? "")) hits.push(n as Text);
  }
  for (const text of hits) {
    const parts = (text.textContent ?? "").split(/(⟦minions-vault:[a-z0-9]+⟧)/);
    const frag = doc.createDocumentFragment();
    for (const part of parts) {
      const m = part.match(/^⟦minions-vault:([a-z0-9]+)⟧$/);
      const item = m ? ctx.vaultItems.get(m[1]!) : undefined;
      if (m && item) {
        const span = el(doc, "span", { "data-vault-item": "", "data-item-id": item.itemId });
        span.textContent = item.label;
        frag.appendChild(span);
      } else if (!m && part) frag.appendChild(doc.createTextNode(part));
    }
    // A token alone in a code block: the block becomes a paragraph with the chip.
    const pre = text.parentElement?.closest("pre");
    if (pre && !pre.textContent?.replace(TOKEN_RE, "").trim()) {
      const p = el(doc, "p");
      p.appendChild(frag);
      pre.replaceWith(p);
    } else text.replaceWith(frag);
  }
}

function toDoc(doc: Document): unknown {
  const clean = DOMPurify.sanitize(doc.body.innerHTML, {
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "button"],
    FORBID_ATTR: ["style", "class", "id"],
  });
  return generateJSON(clean, extensions());
}

// ─── Lines (credential detection and redaction share them) ───────────────────

/**
 * Markdown: the page body's lines. Notion writes line breaks inside a block
 * as `<br>`; each part becomes its own line (ending in two spaces, Markdown's
 * line break) so "User: a<br>Password: b" reads as two labels. Tables and
 * code keep theirs.
 */
export function markdownLines(node: NotionNode): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdownBody(node).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || /^\s*\|/.test(line) || !/<br\s*\/?>/i.test(line)) {
      out.push(line);
      continue;
    }
    const parts = line.split(/<br\s*\/?>/i);
    for (const [i, p] of parts.entries()) out.push(i < parts.length - 1 ? `${p.trimEnd()}  ` : p);
  }
  return out;
}

/** The body of an HTML page as an inert document. */
export function htmlBodyDoc(node: NotionNode): Document {
  const doc = parseHtml(node.text ?? "");
  const body = doc.querySelector(".page-body");
  if (body) doc.body.replaceChildren(...body.childNodes);
  return doc;
}

interface HtmlLines {
  lines: string[];
  /** Line → the element it came from (tables: the row). */
  els: (Element | null)[];
}

/** A block's text, one line per `<br>` ("User: a<br>Password: b" is two labels). */
function brLines(e: Element): string[] {
  if (!e.querySelector("br")) return [e.textContent?.trim() ?? ""];
  const out = [""];
  const walk = (n: Node) => {
    for (const c of n.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) out[out.length - 1] += c.textContent ?? "";
      else if ((c as Element).tagName === "BR") out.push("");
      else walk(c);
    }
  };
  walk(e);
  return out.map((s) => s.trim());
}

/**
 * HTML blocks written as Markdown-ish lines, so the same detector reads
 * both formats: headings get "#", rows "| a | b |", code is fenced.
 */
export function htmlLines(doc: Document): HtmlLines {
  const lines: string[] = [];
  const els: (Element | null)[] = [];
  const push = (line: string, e: Element | null) => {
    lines.push(line);
    els.push(e);
  };
  const walk = (parent: Element) => {
    for (const e of [...parent.children]) {
      const tag = e.tagName;
      if (/^H[1-6]$/.test(tag))
        push(`${"#".repeat(Number(tag[1]))} ${e.textContent?.trim() ?? ""}`, e);
      else if (tag === "PRE") {
        push("```", e);
        for (const l of (e.textContent ?? "").split("\n")) push(l, e);
        push("```", e);
      } else if (tag === "TABLE") {
        const rows = [...e.querySelectorAll("tr")];
        rows.forEach((tr, i) => {
          push(
            `| ${[...tr.children].map((c) => c.textContent?.trim().replace(/\|/g, "\\|") ?? "").join(" | ")} |`,
            tr,
          );
          if (i === 0) push(`|${" --- |".repeat(tr.children.length)}`, null);
        });
      } else if (tag === "P" || (tag === "LI" && !e.querySelector("ul, ol, p, div"))) {
        for (const l of brLines(e)) push(l, e);
      } else if (e.children.length) walk(e);
      else if (e.textContent?.trim()) push(e.textContent.trim(), e);
      push("", null);
    }
  };
  walk(doc.body);
  return { lines, els };
}

/** Takes secrets out of an HTML page in place, leaving vault-item tokens. */
export function redactHtml(doc: Document, html: HtmlLines, creds: Credential[]) {
  for (const c of creds) {
    const whole = c.spans.find((s) => s.whole);
    if (whole) {
      const pre = html.els[whole.line]?.closest("pre");
      if (pre) {
        const p = el(doc, "p");
        p.textContent = tokenFor(c.id);
        pre.replaceWith(p);
      }
      continue;
    }
    let first = true;
    for (const s of c.spans) {
      const host = html.els[s.line];
      if (!host) continue;
      const value = unescapeMd(s.raw);
      const walker = doc.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent ?? "";
        const at = t.lastIndexOf(value);
        if (at < 0) continue;
        n.textContent =
          t.slice(0, at) + (first ? tokenFor(c.id) : "•••") + t.slice(at + value.length);
        first = false;
        break;
      }
    }
  }
}

/** Converts one page's body, with its credentials already decided. */
export function convertPage(
  node: NotionNode,
  creds: { redact: Credential[] },
  ctx: ConvertContext,
): unknown {
  let doc: Document;
  if (node.format === "html") {
    doc = htmlBodyDoc(node);
    // The database's own table is shown by the database view, not as content.
    for (const t of [...doc.querySelectorAll("table.collection-content")]) t.remove();
    redactHtml(doc, htmlLines(doc), creds.redact);
  } else {
    const md = redactLines(markdownLines(node), creds.redact).join("\n");
    doc = parseHtml(marked.parse(md, { gfm: true, async: false }) as string);
  }
  normalize(doc, ctx);
  placeVaultItems(doc, ctx);
  return toDoc(doc);
}

/**
 * HTML exports have no CSV: a database page carries its rows in
 * <table class="collection-content">. Reads columns and row values from it
 * and attaches them to the row pages.
 */
export function readHtmlDatabases(exp: NotionExport) {
  for (const node of exp.nodes.values()) {
    if (node.format !== "html" || !node.text?.includes("collection-content")) continue;
    const doc = parseHtml(node.text);
    const table = doc.querySelector("table.collection-content");
    if (!table) continue;
    const columns = [...table.querySelectorAll("thead th")].map(
      (th) => th.textContent?.trim() ?? "",
    );
    node.kind = "database";
    exp.databases.set(node.key, { key: node.key, columns });
    [...table.querySelectorAll("tbody tr")].forEach((tr, i) => {
      const values = [...tr.children].map((td) => td.textContent?.trim() ?? "");
      const row = Object.fromEntries(columns.map((c, k) => [c, values[k] ?? ""]));
      const href = tr.querySelector("a[href]")?.getAttribute("href") ?? "";
      const id = notionIdIn(href);
      const key = id ? exp.byNotionId.get(id) : undefined;
      const rowNode = key ? exp.nodes.get(key) : undefined;
      if (rowNode) {
        rowNode.row = row;
        rowNode.rowIndex = i;
        if (rowNode.parentKey !== node.key) {
          if (rowNode.parentKey) {
            const old = exp.nodes.get(rowNode.parentKey);
            if (old) old.children = old.children.filter((k) => k !== rowNode.key);
          }
          rowNode.parentKey = node.key;
          node.children.push(rowNode.key);
        }
      }
    });
    node.children.sort(
      (a, b) => (exp.nodes.get(a)!.rowIndex ?? 1e9) - (exp.nodes.get(b)!.rowIndex ?? 1e9),
    );
  }
  exp.roots = exp.roots.filter((k) => !exp.nodes.get(k)?.parentKey);
}

/** Resolves links for a conversion: exported pages by id, exported files by path. */
export function linkResolver(exp: NotionExport, pageIds: Map<string, string>) {
  return (href: string, node: NotionNode): LinkTarget => {
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("#")) return { kind: "none" };
    const notionId = notionIdIn(trimmed);
    const key = notionId ? exp.byNotionId.get(notionId) : undefined;
    if (key && pageIds.has(key)) return { kind: "page", pageId: pageIds.get(key)! };
    if (/^(https?:|mailto:)/i.test(trimmed)) return { kind: "external", href: trimmed };
    const path = resolvePath(node.dir, trimmed);
    const file = path ? exp.files.get(path) : undefined;
    if (path && file && !/\.(md|html|csv)$/i.test(path))
      return { kind: "file", path, name: path.slice(path.lastIndexOf("/") + 1), size: file.size };
    return { kind: "none" };
  };
}
