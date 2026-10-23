// End-to-end test of encrypted pages and the Notion import.
//   pnpm dev   (API on :4600, web on :5180)
//   node tests/e2e/pages.mjs [screenshotDir]
// Registers a throwaway account, writes nested pages with the block editor,
// checks they survive a lock and unlock, imports a small Notion export and
// checks its passwords became vault items, not page text.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  BlobWriter,
  TextReader,
  ZipWriter,
} from "../../apps/web/node_modules/@zip.js/zip.js/index.js";

const BASE = process.env.WEB_URL ?? "http://localhost:5180";
const OUT = process.argv[2] ?? "tests/e2e/screenshots";
mkdirSync(OUT, { recursive: true });

const email = `pages-${Date.now()}@example.com`;
const password = "Correct-Horse-Battery-Staple-42";
const errors = [];
const NOTION_SECRET = "Notion-Imported-Pw-77!";

async function notionZip() {
  const h = "11111111111111111111111111111111";
  const a = "33333333333333333333333333333333";
  const files = {
    [`Team Wiki ${h}.md`]: [
      "# Team Wiki",
      "",
      `Our accounts live in [Accounts](Team%20Wiki%20${h}/Accounts%20${a}.csv).`,
      "",
      "## Office wifi",
      "",
      "Network: Office",
      "",
      `Password: ${NOTION_SECRET}`,
      "",
      "- [x] Imported from Notion",
    ].join("\n"),
    [`Team Wiki ${h}/Accounts ${a}.csv`]:
      "Name,URL,Username,Password\nGitHub,https://github.com,octo@acme.test,gh-Imported-1!\n",
    [`Team Wiki ${h}/Accounts ${a}/GitHub 44444444444444444444444444444444.md`]:
      "# GitHub\n\nURL: https://github.com\nUsername: octo@acme.test\nPassword: gh-Imported-1!\n\nOrg owner.",
  };
  const writer = new ZipWriter(new BlobWriter("application/zip"));
  for (const [path, text] of Object.entries(files)) await writer.add(path, new TextReader(text));
  const blob = await writer.close();
  const path = join(tmpdir(), `notion-export-${Date.now()}.zip`);
  writeFileSync(path, Buffer.from(await blob.arrayBuffer()));
  return path;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
    errors.push(`console: ${m.text()}`);
});

const nav = async (path) => {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.waitForTimeout(200);
};
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const step = (name) => console.log(`• ${name}`);
const editor = () => page.locator(".page-prose .ProseMirror");

try {
  step("register");
  await page.goto(`${BASE}/register`);
  await page.getByLabel("Name").fill("Pages Test");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Master password", { exact: true }).fill(password);
  await page.getByLabel("Confirm master password").fill(password);
  await page.getByRole("button", { name: "Create vault" }).click();
  await page.getByRole("navigation", { name: "Vault" }).waitFor({ timeout: 30_000 });

  step("create a page from the sidebar");
  await page.getByRole("button", { name: "New page" }).first().click();
  await page.waitForURL(/\/pages\/[0-9a-f-]{36}/);
  const rootUrl = page.url();
  await page.getByPlaceholder("Untitled").fill("Engineering handbook");
  await editor().click();
  await page.keyboard.type("Welcome to the handbook.");
  await page.keyboard.press("Enter");

  step("slash menu: heading, to-do, callout, toggle");
  await page.keyboard.type("/heading 2");
  await page.getByRole("option", { name: /Heading 2/ }).waitFor();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Deploys");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/todo");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ship pages");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/callout");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Never deploy on Friday.");
  await editor().locator("h2", { hasText: "Deploys" }).waitFor();
  await editor().locator('ul[data-type="taskList"]', { hasText: "Ship pages" }).waitFor();
  await editor().locator(".callout", { hasText: "Never deploy" }).waitFor();

  step("sub-page via the slash menu");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/page");
  await page.getByRole("option", { name: /^Page/ }).click();
  await editor().locator(".page-link").first().waitFor();
  await page.getByText("Saved", { exact: false }).first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1200);
  await shot("pages-01-editor");

  step("tree shows the sub-page under its parent");
  const tree = page.locator("li", { hasText: "Engineering handbook" }).first();
  await tree.getByRole("button", { name: "Expand" }).first().click();
  await tree.locator("li", { hasText: "Untitled" }).first().waitFor();
  await editor().locator('ul[data-type="taskList"] > li').first().waitFor();
  const box = await editor().locator('ul[data-type="taskList"] > li').first().boundingBox();
  if (!box || box.height > 40) throw new Error("to-do checkbox and text are not on one line");

  step("lock, unlock: everything decrypts again");
  await page.getByRole("button", { name: "Lock vault" }).first().click();
  await page.getByText("Vault locked").waitFor();
  await page.getByLabel("Master password").fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("button", { name: "New page" }).first().waitFor({ timeout: 30_000 });
  await nav(new URL(rootUrl).pathname);
  await page.getByPlaceholder("Untitled").waitFor({ timeout: 30_000 });
  if ((await page.getByPlaceholder("Untitled").inputValue()) !== "Engineering handbook")
    throw new Error("title did not survive a lock");
  await editor().locator(".callout", { hasText: "Never deploy" }).waitFor();

  step("import a Notion export");
  await nav("/import/notion");
  await page.locator('input[type="file"]').setInputFiles(await notionZip());
  await page.getByText("Passwords & keys found").waitFor({ timeout: 30_000 });
  await shot("pages-02-import-preview");
  await page.getByRole("button", { name: /Encrypt & import/ }).click();
  await page.getByRole("button", { name: "Open the imported pages" }).waitFor({ timeout: 60_000 });
  await shot("pages-03-import-done");
  await page.getByRole("button", { name: "Open the imported pages" }).click();
  await page.waitForURL(/\/pages\//);
  await page.locator("a", { hasText: "Team Wiki" }).first().click();
  await editor().waitFor();
  const text = await editor().innerText();
  if (text.includes(NOTION_SECRET)) throw new Error("the imported password stayed in the page");
  await editor()
    .getByRole("button", { name: /Office wifi/ })
    .waitFor();
  await shot("pages-04-imported-page");

  step("the password is a vault item");
  await editor()
    .getByRole("button", { name: /Office wifi/ })
    .click();
  await page.waitForURL(/\/vault/);
  await page.getByRole("heading", { name: "Office wifi" }).waitFor();
  await nav("/vault");
  await page.getByText("GitHub").first().waitFor();

  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
  console.log("pages e2e passed");
} catch (e) {
  await shot("pages-failure").catch(() => {});
  console.error(e);
  if (errors.length) console.error(errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
