// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { groupOf } from "./credentials";
import { exportZip, ID, SECRETS, workspaceFiles } from "./fixtures";
import {
  databaseSchema,
  inferType,
  NOTION_IMPORT_TAG,
  newWriteState,
  planImport,
  retrying,
  writeImport,
} from "./importer";

// Writing, without a server or a vault key: requests are recorded as sent.
interface SentItem {
  id: string;
  archived?: boolean;
  tags?: string[];
  values: Record<string, string>;
}
interface SentPage {
  id: string;
  archived?: boolean;
  meta: { title: string; imported?: { from: string } };
  content?: unknown;
}
type Body = { entries?: { item: SentItem }[]; pages?: SentPage[] };
const sent = vi.hoisted(() => [] as { path: string; body: Body }[]);
vi.mock("../api", async (real) => ({
  ...(await real<typeof import("../api")>()),
  post: async (path: string, body: Body) => {
    sent.push({ path, body });
    if (path === "/imports") return { id: "job" };
    if (path.endsWith("/items")) return { imported: body.entries!.length, failed: [] };
    return {};
  },
}));
vi.mock("../pages/crypto", () => ({
  buildNewPage: async (o: { id?: string }) => ({
    request: { id: o.id ?? crypto.randomUUID(), ...o },
    key: new Uint8Array(32),
  }),
  uploadPageFile: async () => "file",
}));
vi.mock("../vault-crypto", () => ({
  encryptDraft: async (d: object) => ({ ...d, fields: [] }),
}));
const sentItems = () =>
  sent.filter((s) => s.path.endsWith("/items")).flatMap((s) => s.body.entries!.map((e) => e.item));
const sentPages = () => sent.filter((s) => s.path === "/pages/batch").flatMap((s) => s.body.pages!);

describe("retrying through rate limits", () => {
  const noWait = async () => {};
  it("waits out a 429 and carries on", async () => {
    let calls = 0;
    const result = await retrying(
      async () => {
        calls++;
        if (calls < 3) throw new ApiError(429, "Too many requests");
        return "ok";
      },
      (e) => e instanceof ApiError && e.status === 429,
      6,
      noWait,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry what it was not told to, and gives up eventually", async () => {
    let calls = 0;
    const fail = (status: number) => () => {
      calls++;
      return Promise.reject(new ApiError(status, "nope"));
    };
    const only429 = (e: unknown) => e instanceof ApiError && e.status === 429;
    await expect(retrying(fail(400), only429, 6, noWait)).rejects.toThrow("nope");
    expect(calls).toBe(1);
    calls = 0;
    await expect(retrying(fail(429), only429, 4, noWait)).rejects.toThrow("nope");
    expect(calls).toBe(4);
  });
});

describe("planning a Notion import", () => {
  it("counts what is there and finds every credential, sending nothing", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      calls.push(String(url));
      return Promise.reject(new Error("no network in a plan"));
    }) as typeof fetch;
    try {
      const plan = await planImport([await exportZip()]);
      expect(plan.stats).toMatchObject({
        pages: 3,
        databases: 1,
        rows: 2,
        attachments: 1,
        tooLarge: [],
      });
      const byValue = (v: string) =>
        plan.credentials.find((c) => Object.values(c.values).some((x) => x.includes(v)));
      expect(byValue(SECRETS.github)).toMatchObject({
        source: "row",
        type: "LOGIN",
        nodeKey: ID.github,
      });
      expect(byValue(SECRETS.stripe)).toMatchObject({ type: "API_KEY", nodeKey: ID.stripe });
      expect(byValue(SECRETS.wifi)).toMatchObject({
        source: "text",
        nodeKey: ID.handbook,
        name: "Office wifi",
      });
      expect(byValue(SECRETS.table)).toMatchObject({ source: "table", name: "Figma" });
      expect(plan.credentials.find((c) => c.type === "SSH_KEY")?.nodeKey).toBe(ID.servers);
      expect(plan.credentials).toHaveLength(5);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("writing a Notion import", () => {
  it("makes one archived, tagged item per credential and archives every page", async () => {
    sent.length = 0;
    // The GitHub login is in the database and written again on the onboarding page.
    const files = workspaceFiles();
    const onboarding = Object.keys(files).find((p) => p.includes(`Onboarding ${ID.onboarding}`))!;
    files[onboarding] =
      `# Onboarding\n\nURL: https://github.com\nUsername: dev@acme.test\nPassword: ${SECRETS.github}\n`;
    const plan = await planImport([await exportZip(files)]);
    expect(plan.stats.duplicates).toBe(1);
    const leaders = plan.credentials.filter((c) => !c.duplicateOf);

    const result = await writeImport(
      plan,
      {
        include: new Set(plan.exp.nodes.keys()),
        choices: new Map(leaders.map((c) => [c.id, { vault: true, type: c.type, name: c.name }])),
        parentId: null,
        containerTitle: "Notion",
        after: null,
      },
      newWriteState(),
    );

    const items = sentItems();
    expect(items).toHaveLength(leaders.length);
    expect(result.items).toBe(leaders.length);
    for (const item of items) {
      expect(item.archived).toBe(true);
      expect(item.tags).toEqual([NOTION_IMPORT_TAG]);
    }
    const github = items.find((i) => i.values.password === SECRETS.github)!;
    expect(github.values.notes).toMatch(/found on 2 pages/);

    const pages = sentPages();
    expect(pages).toHaveLength(plan.exp.nodes.size + 1);
    for (const p of pages) {
      expect(p.archived).toBe(true);
      expect(p.meta.imported).toMatchObject({ from: "notion" });
    }
    // Both pages link to the one item, and neither keeps the password.
    const linking = pages.filter((p) => JSON.stringify(p.content ?? null).includes(github.id));
    expect(linking.map((p) => p.meta.title).sort()).toEqual(["GitHub", "Onboarding"]);
    expect(JSON.stringify(pages)).not.toContain(SECRETS.github);
    const dup = plan.credentials.find((c) => c.duplicateOf)!;
    expect(groupOf(dup)).not.toBe(dup.id);
  });

  it("can leave what it imports unarchived", async () => {
    sent.length = 0;
    const plan = await planImport([await exportZip()]);
    await writeImport(
      plan,
      {
        include: new Set(plan.exp.nodes.keys()),
        choices: new Map(),
        parentId: null,
        containerTitle: null,
        after: null,
        archive: false,
      },
      newWriteState(),
    );
    const pages = sentPages();
    const items = sentItems();
    expect(pages.some((p) => p.archived)).toBe(false);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.archived)).toBe(false);
  });
});

describe("database schemas", () => {
  it("infers property types from values", () => {
    expect(inferType(["1", "2.5", ""])).toBe("number");
    expect(inferType(["Yes", "No"])).toBe("checkbox");
    expect(inferType(["https://a.com", "http://b.org"])).toBe("url");
    expect(inferType(["a@b.co"])).toBe("email");
    expect(inferType(["Done", "Todo", "Done", "Todo", "Done"])).toBe("select");
    expect(inferType(["a, b", "b", "a, b"])).toBe("multi_select");
    expect(inferType(["free text", "more text"])).toBe("text");
  });

  it("keeps the first column as the title and can leave out secret columns", () => {
    const rows = [{ Name: "GitHub", Password: "x", Tags: "eng" }];
    const schema = databaseSchema(["Name", "Password", "Tags"], rows, new Set(["Password"]));
    expect(schema.properties.map((p) => [p.name, p.type])).toEqual([
      ["Name", "title"],
      ["Tags", "text"],
    ]);
  });
});
