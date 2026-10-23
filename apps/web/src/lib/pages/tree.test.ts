import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  childrenOf,
  indexPages,
  isWithin,
  type PageEntry,
  positionAtEnd,
  positionBetween,
  positions,
  searchPages,
} from "./tree";

const page = (id: string, parentId: string | null, position: string, title = id): PageEntry => ({
  id,
  parentId,
  position,
  kind: "page",
  favorite: false,
  revision: 1,
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
  protectedKey: "",
  metaEnc: "",
  title,
});

describe("page tree", () => {
  const pages = [
    page("b", null, "a1", "Café notes"),
    page("a", null, "a0", "Handbook"),
    page("a2", "a", "a1", "Onboarding"),
    page("a1", "a", "a0", "Benefits"),
    page("a1x", "a1", "a0", "Dental plan"),
    page("orphan", "gone", "a0", "Orphan"),
  ];
  const index = indexPages(pages);

  it("orders siblings and puts orphans at the top level", () => {
    expect(childrenOf(index, null).map((p) => p.id)).toEqual(["a", "orphan", "b"]);
    expect(childrenOf(index, "a").map((p) => p.id)).toEqual(["a1", "a2"]);
  });

  it("walks ancestors and knows what is inside what", () => {
    expect(ancestorsOf(index, "a1x").map((p) => p.id)).toEqual(["a", "a1"]);
    expect(isWithin(index, "a1x", "a")).toBe(true);
    expect(isWithin(index, "a", "a1x")).toBe(false);
    expect(isWithin(index, "a", "a")).toBe(true);
  });

  it("survives a cycle in bad data", () => {
    const loop = indexPages([page("x", "y", "a0"), page("y", "x", "a0")]);
    expect(ancestorsOf(loop, "x").map((p) => p.id)).toEqual(["y"]);
  });

  it("makes positions that sort where they should", () => {
    const end = positionAtEnd(index, "a");
    expect(end > "a1").toBe(true);
    const mid = positionBetween("a0", "a1");
    expect(mid > "a0" && mid < "a1").toBe(true);
    const many = positions(5);
    expect([...many].sort()).toEqual(many);
  });

  it("searches titles ignoring case and accents", () => {
    expect(searchPages(pages, "cafe").map((p) => p.id)).toEqual(["b"]);
    expect(searchPages(pages, "PLAN dent").map((p) => p.id)).toEqual(["a1x"]);
    expect(searchPages(pages, "  ")).toEqual([]);
  });
});
