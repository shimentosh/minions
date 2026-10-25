// End-to-end test of encrypted pages and the Notion import.
//   pnpm dev   (API on :4600, web on :5180)
//   node tests/e2e/pages.mjs [screenshotDir]
// Registers a throwaway account, writes nested pages with the block editor,
// checks they survive a lock and unlock, imports a small Notion export and
// checks its passwords became vault items, not page text, and that what it
// imported is archived: hidden until shown, archived and brought back singly
// and in bulk.
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
// One person typing must never conflict with their own earlier save.
page.on("response", (r) => {
  if (r.status() === 409 && /\/pages\//.test(r.url())) errors.push(`409 from ${r.url()}`);
});
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

  step("favorite: the star fills and the page is in the sidebar at once");
  await page.getByRole("button", { name: "Add to favorites" }).click();
  await page.getByRole("button", { name: "Remove from favorites" }).waitFor({ timeout: 1000 });
  const sidebar = page.locator('[data-sidebar="sidebar"]').first();
  await sidebar.getByText("Favorites", { exact: true }).waitFor({ timeout: 1000 });
  await sidebar
    .getByRole("button", { name: "Remove Engineering handbook from favorites" })
    .waitFor({ state: "attached" });
  await shot("pages-01b-favorite");

  step("⌘K finds a page by words in its content");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.keyboard.type("friday");
  const hit = page.getByRole("option", { name: /Engineering handbook/ });
  await hit.waitFor({ timeout: 10_000 });
  if ((await hit.locator("mark").innerText()) !== "Friday")
    throw new Error("the palette does not highlight the match");
  await shot("pages-01c-palette-search");
  await page.keyboard.press("Escape");

  step("Pages search finds content too, with a snippet");
  await nav("/pages");
  await page.getByPlaceholder("Search page titles and content…").fill("deploy friday");
  await page.locator("mark", { hasText: "deploy" }).first().waitFor({ timeout: 10_000 });
  await page.getByText("on Friday.").first().waitFor();
  await page.getByPlaceholder("Search page titles and content…").fill("nothing like this");
  await page.getByText("No page matches.").waitFor();

  step("unfavorite from the sidebar");
  await sidebar.getByText("Engineering handbook").first().hover();
  await sidebar.getByRole("button", { name: "Remove Engineering handbook from favorites" }).click();
  await sidebar.getByText("Favorites", { exact: true }).waitFor({ state: "detached" });

  step("move a sub-page to the top level without dragging");
  // The innermost row: its parent's <li> holds "Untitled" too.
  const subRow = sidebar.locator("li", { hasText: "Untitled" }).last();
  await subRow.hover();
  await subRow.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("button", { name: "Top level" }).click();
  await page.getByText("Moved to the top level").waitFor();
  await nav(new URL(rootUrl).pathname);
  await page.getByText("Pages inside").waitFor({ state: "detached" });

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
  // Imported items are archived: the detail says so.
  await page
    .getByRole("button", { name: /Archived/ })
    .first()
    .waitFor();

  step("imported items are hidden until shown");
  await nav("/vault");
  const showArchived = page.getByRole("button", { name: /^Show \d+ archived$/ }).first();
  await showArchived.waitFor({ timeout: 15_000 });
  if (await page.getByRole("checkbox", { name: "Select GitHub" }).count())
    throw new Error("an archived item is listed");
  await showArchived.click();
  await page.getByRole("checkbox", { name: "Select GitHub" }).waitFor();
  await page.getByRole("button", { name: "Hide archived" }).first().click();

  step("unarchive one item, archive it again in bulk");
  await nav("/vault?archived=true");
  // Exact: the draggable row is a button too, and its name contains the menu's.
  await page.getByRole("button", { name: "Actions for GitHub", exact: true }).click();
  await page.getByRole("menuitem", { name: "Unarchive" }).click();
  await nav("/vault");
  await page.getByRole("checkbox", { name: "Select GitHub" }).click();
  await page
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Archive" })
    .click();
  await page.getByRole("checkbox", { name: "Select GitHub" }).waitFor({ state: "detached" });

  step("imported pages are archived; unarchiving the import brings it back");
  await nav("/pages");
  await page.getByPlaceholder("Search page titles and content…").fill("Team Wiki");
  await page.getByText("No page matches.").waitFor();
  await nav("/pages?view=archived");
  await page.getByRole("checkbox", { name: "Select Notion" }).check();
  await page.getByRole("button", { name: /Unarchive 1 page/ }).click();
  await nav("/pages");
  await page.getByPlaceholder("Search page titles and content…").fill("Team Wiki");
  await page
    .getByRole("link", { name: /Team Wiki/ })
    .first()
    .waitFor();
  await shot("pages-05-unarchived");

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
