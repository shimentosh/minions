import { describe, expect, it } from "vitest";
import { docText, snippetOf } from "./search";
import { fold, type PageEntry, searchPages } from "./tree";

const page = (id: string, title: string): PageEntry => ({
  id,
  parentId: null,
  position: "a0",
  kind: "page",
  favorite: false,
  revision: 1,
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
  protectedKey: "",
  metaEnc: "",
  title,
});

describe("page search", () => {
  it("reads the text of a document, one line per block, with item labels", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "Servers" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Login with " },
            { type: "vaultItem", attrs: { itemId: "i1", label: "AWS root" } },
            { type: "text", text: " first." },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
            },
          ],
        },
      ],
    };
    expect(docText(doc)).toBe("Servers\nLogin with AWS root first.\none\ntwo");
    expect(docText(null)).toBe("");
  });

  it("folds Latin accents but keeps the vowel signs of other scripts", () => {
    expect(fold("Café ÉLAN")).toBe("cafe elan");
    // কি and ক are different words: the vowel sign must survive.
    expect(fold("কি")).not.toBe(fold("ক"));
    expect(searchPages([page("a", "কাজের তালিকা"), page("b", "কজ")], "কাজ").map((p) => p.id)).toEqual([
      "a",
    ]);
  });

  it("cuts a one-line snippet around the first matching word", () => {
    const body = "Intro line\nThe staging server password lives in the vault, not here.\nOutro";
    expect(snippetOf(body, ["pass"])).toEqual({
      before: "The staging server ",
      match: "password",
      after: " lives in the vault, not here.",
    });
    expect(snippetOf(body, ["café"])).toBeNull();
    // The line with more of the words wins over the first line with one.
    const doc = "Deploys\nShip pages\nNever deploy on Friday.";
    // The index's prefix match "deploys" is not a second word.
    expect(snippetOf(doc, ["deploy", "friday"], ["deploys", "deploy", "friday"])).toEqual({
      before: "Never ",
      match: "deploy",
      after: " on Friday.",
    });
    expect(snippetOf("Un café noir", ["cafe"])?.match).toBe("café");
    // A fuzzy match from the index is highlighted.
    expect(snippetOf("Never on Friday", ["fridya"], ["friday"])?.match).toBe("Friday");

    const long = `${"word ".repeat(40)}target ${"tail ".repeat(60)}`;
    const s = snippetOf(long, ["target"])!;
    expect(s.match).toBe("target");
    expect(s.before.startsWith("…")).toBe(true);
    expect(s.after.endsWith("…")).toBe(true);
    expect(s.before.length + s.after.length).toBeLessThan(180);
  });
});
