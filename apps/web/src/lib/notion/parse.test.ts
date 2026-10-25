import { describe, expect, it } from "vitest";
import { exportFiles, ID, workspaceFiles } from "./fixtures";
import {
  analyzeExport,
  markdownBody,
  matchRows,
  type NotionNode,
  notionIdIn,
  resolvePath,
  splitName,
} from "./parse";

describe("Notion export structure", () => {
  it("reads names, ids and links", () => {
    expect(splitName(`Company Handbook ${ID.handbook}`)).toEqual({
      title: "Company Handbook",
      id: ID.handbook,
    });
    expect(splitName("Plain folder")).toEqual({ title: "Plain folder", id: null });
    expect(resolvePath("A/B", "../C%20D/e.png")).toBe("A/C D/e.png");
    expect(resolvePath("A", "https://example.com/x.png")).toBeNull();
    expect(notionIdIn(`Onboarding%20${ID.onboarding}.md`)).toBe(ID.onboarding);
    expect(
      notionIdIn("https://www.notion.so/acme/Onboarding-22222222222222222222222222222222"),
    ).toBe(ID.onboarding);
    expect(notionIdIn("https://www.notion.so/22222222-2222-2222-2222-222222222222")).toBe(
      ID.onboarding,
    );
  });

  it("keeps the page hierarchy and databases", async () => {
    const exp = await analyzeExport(exportFiles());
    const handbook = exp.nodes.get(ID.handbook)!;
    expect(exp.roots.sort()).toEqual([ID.handbook, ID.servers].sort());
    expect(handbook.parentKey).toBeNull();
    // Ordered as the handbook first mentions them.
    expect(handbook.children).toEqual([ID.onboarding, ID.accounts]);

    const accounts = exp.nodes.get(ID.accounts)!;
    expect(accounts.kind).toBe("database");
    expect(accounts.parentKey).toBe(ID.handbook);
    expect(exp.databases.get(ID.accounts)!.columns).toEqual([
      "Name",
      "URL",
      "Username",
      "Password",
      "Tags",
    ]);
    expect(accounts.children).toEqual([ID.github, ID.stripe]);
    expect(exp.nodes.get(ID.github)!.row).toMatchObject({
      Name: "GitHub",
      Username: "dev@acme.test",
    });
    expect(exp.nodes.get(ID.github)!.rowIndex).toBe(0);
    expect(exp.warnings).toEqual([]);
  });

  it("drops the title and a row's property lines from the body", async () => {
    const exp = await analyzeExport(exportFiles());
    const body = markdownBody(exp.nodes.get(ID.github)!);
    expect(body.trim()).toBe("Org owner account. Keep 2FA on.");
    expect(markdownBody(exp.nodes.get(ID.onboarding)!).trim()).toBe(
      "Day one: laptop, accounts, coffee.",
    );
  });

  it("turns database rows without a page into pages", async () => {
    const files = exportFiles().filter((f) => !f.path.includes(`Stripe ${ID.stripe}`));
    const exp = await analyzeExport(files);
    const accounts = exp.nodes.get(ID.accounts)!;
    expect(accounts.children).toHaveLength(2);
    const stripe = exp.nodes.get(accounts.children[1]!)!;
    expect(stripe.title).toBe("Stripe");
    expect(stripe.file).toBeUndefined();
  });

  it("reads newer exports, whose sub-page folders are named by title alone", async () => {
    const files = Object.fromEntries(
      Object.entries(workspaceFiles()).map(([path, content]) => [
        path
          .replace(`Company Handbook ${ID.handbook}/`, "Company Handbook/")
          .replace(`Accounts ${ID.accounts}/`, "Accounts/"),
        content,
      ]),
    );
    const exp = await analyzeExport(exportFiles(files));
    expect(exp.roots.sort()).toEqual([ID.handbook, ID.servers].sort());
    expect(exp.nodes.get(ID.onboarding)!.parentKey).toBe(ID.handbook);
    expect(exp.nodes.get(ID.accounts)!.children).toEqual([ID.github, ID.stripe]);
    expect(exp.nodes.get(ID.github)!.row).toMatchObject({ Name: "GitHub" });
  });

  it("does not guess a folder two pages could own", async () => {
    const exp = await analyzeExport(
      exportFiles({
        [`Notes ${ID.handbook}.md`]: "# Notes",
        [`Notes ${ID.servers}.md`]: "# Notes",
        [`Notes/Child ${ID.onboarding}.md`]: "# Child",
      }),
    );
    expect(exp.nodes.get(ID.onboarding)!.parentKey).toBeNull();
  });

  it("pairs CSV rows with row pages whose file names lost characters", () => {
    const page = (title: string) => ({ title }) as NotionNode;
    const pages = [
      page("Untitled"),
      page("Q3 Plan Budget"),
      page("A very long row title that Notion cut s"),
      page("Exact"),
    ];
    const titles = [
      "Exact",
      "Q3 Plan: Budget",
      "A very long row title that Notion cut short in the file name",
      "",
      "No page",
    ];
    expect(matchRows(titles, pages)).toEqual([pages[3], pages[1], pages[2], pages[0], undefined]);
  });

  it("says so when there is nothing to import", async () => {
    const exp = await analyzeExport([]);
    expect(exp.nodes.size).toBe(0);
    expect(exp.warnings[0]).toMatch(/No Notion pages/);
  });
});
