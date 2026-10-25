// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  convertPage,
  htmlBodyDoc,
  htmlLines,
  linkResolver,
  markdownLines,
  readHtmlDatabases,
} from "./convert";
import { detectCredentials } from "./credentials";
import { exportFiles, ID, SECRETS } from "./fixtures";
import { analyzeExport, type NotionNode } from "./parse";

type J = { type: string; attrs?: Record<string, unknown>; content?: J[]; text?: string };

function nodesOf(doc: J, type: string): J[] {
  const out: J[] = [];
  const walk = (n: J) => {
    if (n.type === type) out.push(n);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

async function setup(files = exportFiles()) {
  const exp = await analyzeExport(files);
  readHtmlDatabases(exp);
  const pageIds = new Map([...exp.nodes.keys()].map((k) => [k, `page-${k.slice(0, 4)}`]));
  return { exp, pageIds, resolve: linkResolver(exp, pageIds) };
}

function convert(
  s: Awaited<ReturnType<typeof setup>>,
  node: NotionNode,
  items: "vault" | "keep" = "vault",
) {
  let n = 0;
  const creds = detectCredentials(
    node.format === "html" ? htmlLines(htmlBodyDoc(node)).lines : markdownLines(node),
    {
      nodeKey: node.key,
      title: node.title,
      nextId: () => `c${n++}`,
    },
  );
  const vaultItems = new Map(
    creds.map((c) => [c.id, items === "vault" ? { itemId: `item-${c.id}`, label: c.name } : null]),
  );
  const files: string[] = [];
  const doc = convertPage(
    node,
    { redact: items === "vault" ? creds : [] },
    {
      node,
      resolve: s.resolve,
      vaultItems,
      fileIdFor: (path) => {
        files.push(path);
        return `file-${files.length}`;
      },
    },
  ) as J;
  return { doc, creds, files };
}

describe("converting Notion pages", () => {
  it("turns Markdown into the page schema, with links, files, to-dos and callouts", async () => {
    const s = await setup();
    const { doc, files } = convert(s, s.exp.nodes.get(ID.handbook)!);
    expect(doc.type).toBe("doc");
    // The title is the page's meta, not a heading in the body.
    expect(nodesOf(doc, "heading").map((h) => h.content?.[0]?.text)).toEqual(["Office wifi"]);
    expect(nodesOf(doc, "pageLink").map((l) => l.attrs?.pageId)).toEqual([
      s.pageIds.get(ID.onboarding),
      s.pageIds.get(ID.accounts),
    ]);
    expect(nodesOf(doc, "pageImage")).toEqual([
      { type: "pageImage", attrs: { fileId: "file-1", alt: "Floor plan" } },
    ]);
    expect(files).toEqual([`Export-abc/Company Handbook ${ID.handbook}/floor.png`]);
    const tasks = nodesOf(doc, "taskItem");
    expect(tasks.map((t) => t.attrs?.checked)).toEqual([true, false]);
    const callout = nodesOf(doc, "callout")[0]!;
    expect(callout.attrs?.icon).toBe("💡");
    expect(JSON.stringify(callout)).toContain("Ask in #general");
    expect(nodesOf(doc, "table")).toHaveLength(1);
  });

  it("replaces secrets with vault item chips, and keeps them when asked", async () => {
    const s = await setup();
    const handbook = s.exp.nodes.get(ID.handbook)!;
    const moved = convert(s, handbook, "vault");
    const json = JSON.stringify(moved.doc);
    expect(json).not.toContain(SECRETS.wifi);
    expect(json).not.toContain(SECRETS.table);
    expect(json).not.toContain("minions-vault");
    const chips = nodesOf(moved.doc, "vaultItem");
    expect(chips.map((c) => c.attrs?.itemId).sort()).toEqual(
      moved.creds.map((c) => `item-${c.id}`).sort(),
    );
    // Non-secret text around them stays.
    expect(json).toContain("Network: Office");
    expect(json).toContain("design@acme.test");

    const kept = JSON.stringify(convert(s, handbook, "keep").doc);
    expect(kept).toContain(SECRETS.wifi);
    expect(kept).not.toContain("vaultItem");
  });

  it("turns a private key in a code block into a chip, not a code block", async () => {
    const s = await setup();
    const { doc } = convert(s, s.exp.nodes.get(ID.servers)!);
    expect(JSON.stringify(doc)).not.toContain("PRIVATE KEY");
    expect(nodesOf(doc, "codeBlock")).toHaveLength(0);
    expect(nodesOf(doc, "vaultItem")).toHaveLength(1);
  });

  it("reads the HTML export: toggles, callouts, to-dos and databases", async () => {
    const page = `<html><body><article><header><h1 class="page-title">Runbook</h1></header><div class="page-body">
      <ul class="toggle"><li><details open=""><summary>When the site is down</summary><p>Check the status page.</p></details></li></ul>
      <figure class="callout"><div style="font-size:1.5em"><span class="icon">⚠️</span></div><div style="width:100%"><p>Never deploy on Friday.</p></div></figure>
      <ul class="to-do-list"><li><div class="checkbox checkbox-on"></div> <span class="to-do-children-checked">Back up</span></li></ul>
      <p onclick="alert(1)">Contact <a href="https://status.example.com" onclick="x()">status</a><script>alert(2)</script></p>
      <p>Password: html-Secret-9</p>
    </div></article></body></html>`;
    const db = `<html><body><div class="page-body"><table class="collection-content"><thead><tr><th>Name</th><th>Owner</th></tr></thead>
      <tbody><tr><td><a href="Team%20${ID.github}/Alice%20${ID.onboarding}.html">Alice</a></td><td>Ops</td></tr></tbody></table></div></body></html>`;
    const files = exportFiles({
      [`Runbook ${ID.handbook}.html`]: page,
      [`Team ${ID.github}.html`]: db,
      [`Team ${ID.github}/Alice ${ID.onboarding}.html`]:
        "<html><body><div class='page-body'><p>Hi</p></div></body></html>",
    });
    const s = await setup(files);
    expect(s.exp.nodes.get(ID.github)!.kind).toBe("database");
    expect(s.exp.nodes.get(ID.onboarding)!.row).toEqual({ Name: "Alice", Owner: "Ops" });

    const { doc, creds } = convert(s, s.exp.nodes.get(ID.handbook)!);
    const json = JSON.stringify(doc);
    expect(nodesOf(doc, "details")).toHaveLength(1);
    expect(JSON.stringify(nodesOf(doc, "detailsSummary"))).toContain("When the site is down");
    expect(nodesOf(doc, "callout")[0]!.attrs?.icon).toBe("⚠️");
    expect(nodesOf(doc, "taskItem")[0]!.attrs?.checked).toBe(true);
    expect(json).not.toContain("alert");
    expect(json).not.toContain("onclick");
    expect(json).toContain("https://status.example.com");
    // Notion's page title header is not part of the body.
    expect(nodesOf(doc, "heading")).toHaveLength(0);
    expect(creds).toHaveLength(1);
    expect(json).not.toContain("html-Secret-9");
  });

  it("reads line breaks inside a block as lines, in Markdown and HTML", () => {
    const base = { key: "k", notionId: null, title: "Mail", kind: "page", parentKey: null };
    const md = {
      ...base,
      dir: "",
      children: [],
      format: "md",
      text: "# Mail\n\nUser: me@acme.test<br>Password: br-Secret-1\n\n| a<br>b | c |",
    } as NotionNode;
    const lines = markdownLines(md);
    expect(lines).toContain("Password: br-Secret-1");
    // Tables keep their <br>: a row is one line.
    expect(lines).toContain("| a<br>b | c |");
    const ctx = { nodeKey: "k", title: "Mail", nextId: () => "x" };
    expect(detectCredentials(lines, ctx)[0]!.values).toMatchObject({
      email: "me@acme.test",
      password: "br-Secret-1",
    });

    const html = {
      ...md,
      format: "html",
      text: '<div class="page-body"><p>User: me@acme.test<br>Password: <b>br-Secret-2</b></p></div>',
    } as NotionNode;
    const doc = htmlBodyDoc(html);
    const h = htmlLines(doc);
    expect(detectCredentials(h.lines, ctx)[0]!.values.password).toBe("br-Secret-2");
  });
});
