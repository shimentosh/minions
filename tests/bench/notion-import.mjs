// How the Notion import copes with a large workspace, through the real web app.
//   pnpm dev   then   node tests/bench/notion-import.mjs [pages] [images]
// Generates a Markdown & CSV export (nested pages, a credentials database,
// images), imports it in a browser and reports how long each stage took.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  BlobWriter,
  TextReader,
  Uint8ArrayReader,
  ZipWriter,
} from "../../apps/web/node_modules/@zip.js/zip.js/index.js";

const BASE = process.env.WEB_URL ?? "http://localhost:5180";
const PAGES = Number(process.argv[2] ?? 2000);
const IMAGES = Number(process.argv[3] ?? 200);
const ROWS = 300;
const hex = (n) => n.toString(16).padStart(32, "0");

async function buildExport() {
  const writer = new ZipWriter(new BlobWriter("application/zip"), { level: 1 });
  const image = new Uint8Array(40_000).map((_, i) => (i * 31) % 256);
  const sections = 20;
  const perSection = Math.ceil(PAGES / sections);
  let id = 1;
  let images = 0;
  for (let s = 0; s < sections; s++) {
    const sid = hex(id++);
    const dir = `Workspace/Section ${s} ${sid}`;
    const kids = [];
    for (let p = 0; p < perSection; p++) {
      const pid = hex(id++);
      kids.push(`[Page ${s}.${p}](Section%20${s}%20${sid}/Page%20${s}.${p}%20${pid}.md)`);
      const img = images < IMAGES ? `\n\n![diagram](Page%20${s}.${p}%20${pid}/diagram.png)` : "";
      if (img) {
        await writer.add(`${dir}/Page ${s}.${p} ${pid}/diagram.png`, new Uint8ArrayReader(image));
        images++;
      }
      const body = [
        `# Page ${s}.${p}`,
        "",
        `Notes for page ${s}.${p}. `.repeat(20),
        "",
        "- [ ] follow up",
        "- [x] done",
        "",
        "## Details",
        "",
        "Some **bold** and _italic_ text with a [link](https://example.com).",
        p % 50 === 0 ? `\nUsername: user${p}@acme.test\n\nPassword: Pw-${s}-${p}-x!` : "",
        img,
      ].join("\n");
      await writer.add(`${dir}/Page ${s}.${p} ${pid}.md`, new TextReader(body));
    }
    await writer.add(
      `Workspace/Section ${s} ${sid}.md`,
      new TextReader(`# Section ${s}\n\n${kids.join("\n\n")}`),
    );
  }
  const dbid = hex(id++);
  const rows = ["Name,URL,Username,Password,Team"];
  for (let r = 0; r < ROWS; r++)
    rows.push(`Service ${r},https://s${r}.example.com,u${r}@acme.test,Pw-row-${r}!,Team ${r % 5}`);
  await writer.add(`Workspace/Accounts ${dbid}.csv`, new TextReader(rows.join("\n")));
  const blob = await writer.close();
  const path = join(tmpdir(), `notion-bench-${Date.now()}.zip`);
  writeFileSync(path, Buffer.from(await blob.arrayBuffer()));
  return { path, size: blob.size, images };
}

const t0 = Date.now();
const { path, size, images } = await buildExport();
console.log(
  `export: ${PAGES} pages, ${ROWS} database rows, ${images} images, ${(size / 1e6).toFixed(1)} MB (built in ${Date.now() - t0} ms)`,
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const password = "Correct-Horse-Battery-Staple-42";
try {
  await page.goto(`${BASE}/register`);
  await page.getByLabel("Name").fill("Bench");
  await page.getByLabel("Email").fill(`bench-${Date.now()}@example.com`);
  await page.getByLabel("Master password", { exact: true }).fill(password);
  await page.getByLabel("Confirm master password").fill(password);
  await page.getByRole("button", { name: "Create vault" }).click();
  await page.getByRole("navigation", { name: "Vault" }).waitFor({ timeout: 30_000 });
  await page.evaluate(() => {
    window.history.pushState({}, "", "/import/notion");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.locator('input[type="file"]').waitFor({ state: "attached" });

  let t = Date.now();
  await page.locator('input[type="file"]').setInputFiles(path);
  await page.getByText("Passwords & keys found").waitFor({ timeout: 600_000 });
  const plan = Date.now() - t;
  console.log(`preview ready: ${plan} ms`);

  t = Date.now();
  await page.getByRole("button", { name: /Encrypt & import/ }).click();
  await page
    .getByRole("button", { name: "Open the imported pages" })
    .waitFor({ timeout: 1_800_000 });
  const write = Date.now() - t;
  console.log(`encrypted and imported: ${write} ms`);
  console.log(await page.locator("text=/pages, .* vault items and .* files/").first().innerText());
  const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  if (heap) console.log(`tab JS heap after import: ${(heap / 1e6).toFixed(0)} MB`);

  t = Date.now();
  await page.evaluate(() => {
    window.history.pushState({}, "", "/pages");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByPlaceholder("Search page titles…").fill("Page 7.3");
  await page
    .getByRole("link", { name: /Page 7\.3/ })
    .first()
    .waitFor({ timeout: 60_000 });
  console.log(`title search over every page: ${Date.now() - t} ms`);
} catch (e) {
  await page.screenshot({ path: join(tmpdir(), "notion-bench-failure.png") }).catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
