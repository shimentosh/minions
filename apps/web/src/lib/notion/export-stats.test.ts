// @vitest-environment jsdom
import { existsSync, openAsBlob, readFileSync, writeFileSync } from "node:fs";
import { findSecrets } from "@minions/core";
import { describe, it } from "vitest";
import { convertPage, linkResolver, markdownLines } from "./convert";
import { type Credential, dedupeKey, redactLines, TOKEN_RE, whyNotLabel } from "./credentials";
import { planImport } from "./importer";

/**
 * Aggregate statistics for a real Notion export, without printing any of it:
 *   NOTION_EXPORT=/path/to/export.zip pnpm --filter @minions/web exec vitest run export-stats
 * Runs what the import runs before anything is sent (read, build the tree,
 * find credentials, convert every page with its secrets taken out) and
 * prints counts only. Page text, titles and secrets never reach the output:
 * labels of credential-looking lines are reduced to a fixed list of words.
 * Skipped unless NOTION_EXPORT is set (or apps/web/node_modules/.cache/notion-export
 * holds the path, for shells where setting a variable is awkward).
 */

const PATH_FILE = "node_modules/.cache/notion-export";
const PATH =
  process.env.NOTION_EXPORT ||
  (existsSync(PATH_FILE) ? readFileSync(PATH_FILE, "utf8").trim() : "") ||
  undefined;

/** Words that may appear in the output; anything else becomes "·". */
const SAFE_WORDS = new Set(
  (
    "password passwd pass pwd pw passcode passphrase pin key keys secret token api apikey access " +
    "auth client private public user username login email mail id account admin root master " +
    "wifi wi-fi db database ftp sftp ssh server host url site app code codes otp 2fa totp mfa " +
    "backup recovery new old default my the for and of to app-specific app_password"
  ).split(" "),
);
const mask = (label: string) =>
  label
    .toLowerCase()
    .split(/[\s_/-]+/)
    .filter(Boolean)
    .map((w) => (SAFE_WORDS.has(w.replace(/[^a-z0-9-]/g, "")) ? w.replace(/[^a-z0-9-]/g, "") : "·"))
    .join(" ");

const KEYWORD = /\b(pass(?:word|wd|code|phrase)?|pwd|pw|pin|secret|token|api[\s_-]?key|key)\b/i;

/** Text of each block of a converted page. */
function blocks(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (n: { type?: string; text?: string; content?: unknown[] }, acc: string[]) => {
    if (n.type === "text" && n.text) acc.push(n.text);
    if (n.type === "hardBreak") acc.push("\n");
    // findSecrets skips its own marker, so a chip does not read as a value.
    if (n.type === "vaultItem") acc.push("[REDACTED]");
    const isBlock = ["paragraph", "heading", "codeBlock", "tableCell", "tableHeader"].includes(
      n.type ?? "",
    );
    if (isBlock) {
      const own: string[] = [];
      for (const c of n.content ?? []) walk(c as never, own);
      out.push(...own.join("").split("\n"));
      return;
    }
    for (const c of n.content ?? []) walk(c as never, acc);
  };
  walk(doc as never, []);
  return out;
}

const bump = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};

/** A path segment as a shape: "T id" for "<title> <32 hex>", "T" for a bare title. */
function shape(seg: string, last: boolean): string {
  const ext = last ? (seg.match(/\.([a-z0-9]{1,6})$/i)?.[1]?.toLowerCase() ?? "") : "";
  const name = ext ? seg.slice(0, -ext.length - 1) : seg;
  const s = /^Export-[0-9a-f-]+$/i.test(name)
    ? "Export"
    : /^[0-9a-f]{32}$/i.test(name)
      ? "id"
      : /\s[0-9a-f]{32}_all$/i.test(name)
        ? "T id_all"
        : /\s[0-9a-f]{32}$/i.test(name)
          ? "T id"
          : /\s[0-9a-f]{4,31}$/i.test(name)
            ? "T shortid"
            : "T";
  return ext ? `${s}.${ext}` : s;
}

/** The shape of a value (never the value): one token, a few words, a sentence. */
const valueShape = (v: string | undefined) => {
  const t = (v ?? "").trim();
  if (!t) return "nothing";
  if (/^\|/.test(t)) return "table row";
  if (/^[-*+] |^\d+[.)] /.test(t)) return "list item";
  if (!/\s/.test(t)) return t.length <= 64 ? "one token" : "one long token";
  return t.split(/\s+/).length <= 4 ? "few words" : "sentence";
};

describe.skipIf(!PATH)("Notion export statistics", () => {
  it("reports aggregate numbers only", { timeout: 600_000 }, async () => {
    const started = Date.now();
    const blob = await openAsBlob(PATH!);
    const plan = await planImport([blob]);
    const { exp } = plan;

    const ext: Record<string, number> = {};
    for (const p of exp.files.keys())
      bump(ext, (p.match(/\.([a-z0-9]{1,6})$/i)?.[1] ?? "none").toLowerCase());

    const depthOf = (k: string) => {
      let d = 0;
      let p = exp.nodes.get(k)?.parentKey;
      while (p) {
        d++;
        p = exp.nodes.get(p)?.parentKey;
      }
      return d;
    };
    const depth: Record<string, number> = {};
    let maxDepth = 0;
    const formats: Record<string, number> = {};
    let untitled = 0;
    let rowsWithPage = 0;
    let rowsWithoutPage = 0;
    for (const n of exp.nodes.values()) {
      const d = depthOf(n.key);
      maxDepth = Math.max(maxDepth, d);
      bump(depth, String(d));
      bump(formats, n.format ?? (n.kind === "database" ? "csv-only" : "none"));
      if (!n.title || n.title === "Untitled") untitled++;
      if (n.row) n.file ? rowsWithPage++ : rowsWithoutPage++;
    }

    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const c of plan.credentials) {
      bump(byType, c.type);
      bump(bySource, c.source);
    }
    const groups = new Map<string, Credential[]>();
    for (const c of plan.credentials) {
      const k = dedupeKey(c);
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const dupGroups = [...groups.values()].filter((g) => g.length > 1);
    const credentialPages = new Set(plan.credentials.map((c) => c.nodeKey)).size;
    const noSecret = plan.credentials.filter(
      (c) => !Object.keys(c.values).some((k) => /password|key|secret|token|private|pin/.test(k)),
    ).length;

    // Convert every page with all of its credentials taken out, as the import does.
    const pageIds = new Map([...exp.nodes.keys()].map((k, i) => [k, `p${i}`]));
    const resolve = linkResolver(exp, pageIds);
    const errors: { path: string; error: string }[] = [];
    const residual: Record<string, number> = {};
    const residualLabels: Record<string, number> = {};
    const residualSecrets: Record<string, number> = {};
    const inlineShapes: Record<string, number> = {};
    const entropyShapes: Record<string, number> = {};
    const afterLoneLabel: Record<string, number> = {};
    let leftTokens = 0;
    let missingFiles = 0;
    let unresolvedPageLinks = 0;
    const referenced = new Set<string>();
    for (const node of exp.nodes.values()) {
      if (!node.text) continue;
      const creds = plan.byNode.get(node.key) ?? [];
      const vaultItems = new Map(creds.map((c) => [c.id, { itemId: `i${c.id}`, label: "item" }]));
      try {
        const doc = convertPage(
          node,
          { redact: creds.filter((c) => c.source !== "row") },
          {
            node,
            resolve: (href, n) => {
              const t = resolve(href, n);
              if (t.kind === "file") referenced.add(t.path);
              if (t.kind === "none" && /\.(md|html)(#.*)?$/i.test(href)) unresolvedPageLinks++;
              if (t.kind === "none" && /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(href))
                missingFiles++;
              return t;
            },
            vaultItems,
            fileIdFor: (p) => p,
          },
        );
        const lines = blocks(doc);
        for (const [i, line] of lines.entries()) {
          if (line.includes("⟦minions-vault")) leftTokens++;
          if (line.includes("[REDACTED]")) bump(residual, "secret taken out (chip)");
          for (const s of findSecrets(line)) {
            bump(residualSecrets, s.kind);
            if (s.kind === "high_entropy")
              bump(
                entropyShapes,
                /:\/\/|^www\./i.test(s.value)
                  ? "url"
                  : /^[0-9a-f]{32}$/i.test(s.value)
                    ? "32 hex (a Notion id?)"
                    : /@/.test(s.value)
                      ? "has @"
                      : /\//.test(s.value)
                        ? "path-like"
                        : `other token, ${s.value.length < 24 ? "16-23" : s.value.length < 40 ? "24-39" : "40+"} chars`,
              );
            if (s.kind !== "password") continue;
            // How the value was written: "x: v", "x = v", "x is v", "x v"; and what came before.
            const before = line.slice(0, s.start);
            const sep = /:\s*$/.test(before)
              ? "colon"
              : /=\s*$/.test(before)
                ? "equals"
                : /\bis\s*$/i.test(before)
                  ? "is"
                  : /[-–]\s*$/.test(before)
                    ? "dash"
                    : "space";
            const words = mask(before.replace(/[:=\-–]\s*$/, "").trim()).split(" ");
            bump(inlineShapes, `${words.slice(-4).join(" ") || "(start)"} [${sep}]`);
          }
          const m = line.match(KEYWORD);
          if (!m || line.includes("[REDACTED]")) continue;
          const t = line.trim();
          const label = t.match(/^([^:=]{1,40}?)\s*[:=]\s*(.*)$/);
          if (label?.[2]) {
            bump(residual, "label: value, not taken");
            bump(residualLabels, mask(label[1]!));
          } else if (t.length <= 40 && /[:=]?$/.test(t) && t.split(/\s+/).length <= 4) {
            bump(residual, "label alone (value elsewhere?)");
            bump(residualLabels, `${mask(t.replace(/[:=]$/, ""))} (alone)`);
            const next = lines.slice(i + 1).find((l) => l.trim());
            bump(afterLoneLabel, next?.includes("[REDACTED]") ? "taken (chip)" : valueShape(next));
          } else bump(residual, "prose mentioning a keyword");
        }
      } catch (e) {
        errors.push({
          path: node.file?.path ?? node.key,
          error: e instanceof Error ? e.name : "?",
        });
      }
    }
    // Source lines the detector saw that still hold a "password is x"-like value: why missed.
    const missed: Record<string, number> = {};
    for (const node of exp.nodes.values()) {
      if (!node.text || node.format !== "md") continue;
      const creds = plan.byNode.get(node.key) ?? [];
      const lines = markdownLines(node);
      const red = redactLines(
        lines,
        creds.filter((c) => c.source !== "row"),
      );
      for (const redacted of red) {
        const line = redacted.replace(TOKEN_RE, "");
        const hit = findSecrets(line).find((s) => s.kind === "password");
        if (!hit) continue;
        const why = whyNotLabel(line);
        const sep = line.slice(0, hit.start).match(/(:|=|\bis|[-–])?\s*$/)?.[1] ?? "space";
        bump(
          missed,
          `${why.reason}${why.label ? ` "${mask(why.label)}"` : ""} [${sep}${/^\s*[-*+]\s|^\s*\d+[.)]\s/.test(line) ? ", list" : ""}${/^\s*\|/.test(line) ? ", table" : ""}]`,
        );
      }
    }

    // The export's layout, as shapes: which folders belong to which pages.
    const pathShapes: Record<string, number> = {};
    const folders = new Set<string>();
    for (const p of exp.files.keys()) {
      const segs = p.split("/");
      bump(pathShapes, segs.map((s, i) => shape(s, i === segs.length - 1)).join("/"));
      for (let i = 1; i < segs.length; i++) folders.add(segs.slice(0, i).join("/"));
    }
    const folderOwners: Record<string, number> = {};
    const stripId = (s: string) => s.replace(/\s[0-9a-f]{32}(_all)?$/i, "");
    const pageNames = new Map<string, Set<string>>();
    for (const p of exp.files.keys()) {
      if (!/\.(md|html|csv)$/i.test(p)) continue;
      const dir = p.slice(0, Math.max(0, p.lastIndexOf("/")));
      const name = stripId(p.slice(p.lastIndexOf("/") + 1).replace(/\.(md|html|csv)$/i, ""));
      if (!pageNames.has(dir)) pageNames.set(dir, new Set());
      pageNames.get(dir)!.add(name);
    }
    for (const f of folders) {
      const dir = f.slice(0, Math.max(0, f.lastIndexOf("/")));
      const name = f.slice(f.lastIndexOf("/") + 1);
      bump(
        folderOwners,
        exp.files.has(`${f}.md`) || exp.files.has(`${f}.html`) || exp.files.has(`${f}.csv`)
          ? "named like its page file"
          : pageNames.get(dir)?.has(stripId(name))
            ? "named like its page, without the id"
            : "no page of that name beside it",
      );
    }
    // Database rows: pages under a database that no CSV row claimed, and how a looser
    // title comparison would pair them with the CSV rows that found no page.
    const rowMatching: Record<string, number> = {};
    for (const db of exp.databases.values()) {
      const kids = (exp.nodes.get(db.key)?.children ?? []).map((k) => exp.nodes.get(k)!);
      const pagesLeft = kids.filter((n) => !n.row && n.file);
      const rowsLeft = kids.filter((n) => n.row && !n.file);
      bump(rowMatching, "row pages no CSV row claimed", pagesLeft.length);
      bump(rowMatching, "CSV rows without a page", rowsLeft.length);
      const loose = (s: string) =>
        s
          .normalize("NFKC")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]/gu, "");
      const left = new Set(rowsLeft.map((r) => loose(r.title)));
      for (const p of pagesLeft) {
        const t = loose(p.title);
        if (left.has(t)) bump(rowMatching, "would pair ignoring case and punctuation");
        else if (t && [...left].some((r) => r.startsWith(t) || t.startsWith(r)))
          bump(rowMatching, "would pair by prefix (truncated)");
        else bump(rowMatching, "no plausible pair");
      }
    }
    const columnLabels: Record<string, number> = {};
    for (const db of exp.databases.values())
      for (const c of db.columns) if (KEYWORD.test(c)) bump(columnLabels, mask(c));

    const attachments = [...exp.files.keys()].filter((p) => !/\.(md|html|csv)$/i.test(p));
    const unreferenced = attachments.filter((p) => !referenced.has(p)).length;

    const top = (m: Record<string, number>, n = 25) =>
      Object.fromEntries(
        Object.entries(m)
          .sort((a, b) => b[1] - a[1])
          .slice(0, n),
      );

    const report = JSON.stringify(
      {
        seconds: Math.round((Date.now() - started) / 100) / 10,
        files: { total: exp.files.size, byExtension: top(ext) },
        tree: {
          nodes: exp.nodes.size,
          ...plan.stats,
          tooLarge: plan.stats.tooLarge.length,
          roots: exp.roots.length,
          maxDepth,
          depth,
          formats,
          untitled,
          rowsWithPage,
          rowsWithoutPage,
        },
        links: {
          unresolvedPageLinks,
          missingImages: missingFiles,
          unreferencedAttachments: unreferenced,
        },
        credentials: {
          total: plan.credentials.length,
          pages: credentialPages,
          byType,
          bySource,
          withoutSecretField: noSecret,
          duplicateGroups: dupGroups.length,
          duplicateExtra: dupGroups.reduce((s, g) => s + g.length - 1, 0),
        },
        afterRedaction: {
          leftoverTokens: leftTokens,
          providerSecretsStillInText: residualSecrets,
          highEntropyShapes: entropyShapes,
          keywordLines: residual,
          keywordLabels: top(residualLabels, 40),
          inlinePasswordShapes: top(inlineShapes, 40),
          missedInSource: top(missed, 40),
          afterLoneLabel,
        },
        layout: {
          pathShapes: top(pathShapes, 20),
          folders: folderOwners,
          rowMatching,
          secretLikeColumns: columnLabels,
        },
        warnings: exp.warnings,
        errors,
      },
      null,
      2,
    );
    // Also kept next to the path file: vitest can hide console output.
    writeFileSync("node_modules/.cache/notion-export-stats.json", report);
    console.log(report);
  });
});
