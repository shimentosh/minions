import { describe, expect, it } from "vitest";
import { exportZip, ID, workspaceFiles } from "./fixtures";
import { analyzeExport } from "./parse";
import { readExport } from "./zip";

describe("reading Notion export zips", () => {
  it("lists files and reads them on demand", async () => {
    const files = await readExport([await exportZip()]);
    expect(files.map((f) => f.path).sort()).toEqual(Object.keys(workspaceFiles()).sort());
    const png = files.find((f) => f.path.endsWith("floor.png"))!;
    expect(png.size).toBe(12);
    expect(Array.from((await png.bytes()).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const onboarding = files.find((f) => f.path.includes("Onboarding"))!;
    expect(await onboarding.text()).toContain("Day one");
  });

  it("opens zips inside zips, as split exports come", async () => {
    const files = await readExport([await exportZip(workspaceFiles(), true)]);
    const exp = await analyzeExport(files);
    expect(exp.nodes.get(ID.accounts)?.kind).toBe("database");
    expect(exp.nodes.size).toBe(6);
  });
});
