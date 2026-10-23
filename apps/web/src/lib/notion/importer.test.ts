// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { exportZip, ID, SECRETS } from "./fixtures";
import { databaseSchema, inferType, planImport, retrying } from "./importer";

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
