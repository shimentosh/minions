// Encrypted backup → restore, through the web app.
//   pnpm dev   then   node tests/e2e/backup.mjs
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = process.env.WEB_URL ?? "http://localhost:5180";
const pw = "Correct-Horse-Battery-Staple-42";
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};

const browser = await chromium.launch();

async function account(label) {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const email = `${label}-${Date.now()}@example.com`;
  await page.goto(`${BASE}/register`);
  await page.getByLabel("Name").fill(label);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Master password", { exact: true }).fill(pw);
  await page.getByLabel("Confirm master password").fill(pw);
  await page.getByRole("button", { name: "Create vault" }).click();
  await page.getByRole("navigation", { name: "Vault" }).waitFor({ timeout: 30_000 });
  const nav = async (path) => {
    await page.evaluate((to) => {
      window.history.pushState({}, "", to);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, path);
    await page.waitForTimeout(400);
  };
  return { page, nav, context };
}

async function restore(page, nav, file, password) {
  await nav("/settings?tab=data");
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles(file);
  await page.getByPlaceholder("Master password used for this backup").fill(password);
  await page.getByRole("button", { name: "Decrypt & restore" }).click();
}

try {
  // Account A: a login, a note, then download the encrypted backup.
  const a = await account("backup-a");
  await a.page.getByRole("button", { name: "New item" }).first().click();
  // New items open as a login (as in smoke.mjs).
  await a.page.getByLabel("Name", { exact: true }).fill("GitHub");
  await a.page.getByLabel("Website", { exact: true }).fill("https://github.com/login");
  await a.page.locator("#f-password").fill("Restore-Me-123!");
  await a.page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await a.page.waitForURL(/item=/);
  await a.nav("/notes");
  await a.page.getByRole("button", { name: "New note" }).first().click();
  await a.page.waitForURL(/note=/);
  await a.page.getByPlaceholder("Untitled").fill("Restore runbook");
  await a.page.locator(".ProseMirror").click();
  await a.page.keyboard.type("Secret steps inside");
  await a.page.getByText(/Saved/).waitFor({ timeout: 10_000 });
  await a.page.waitForTimeout(1200);

  // And a page.
  await a.nav("/pages");
  await a.page.getByRole("button", { name: "New page" }).first().click();
  await a.page.waitForURL(/\/pages\/[0-9a-f-]{36}/);
  await a.page.getByPlaceholder("Untitled").fill("Restore handbook");
  await a.page.locator(".page-prose .ProseMirror").click();
  await a.page.keyboard.type("Page body survives");
  await a.page.getByText(/Saved/).first().waitFor({ timeout: 10_000 });
  await a.page.waitForTimeout(1500);

  await a.nav("/settings?tab=data");
  const download = a.page.waitForEvent("download");
  await a.page.getByRole("button", { name: "Download encrypted backup" }).click();
  const file = join(tmpdir(), `minions-backup-${Date.now()}.json`);
  await (await download).saveAs(file);
  const json = JSON.parse((await import("node:fs")).readFileSync(file, "utf8"));
  check(
    json.format === "minions-encrypted-backup" &&
      json.pages?.length === 1 &&
      !JSON.stringify(json).includes("Restore-Me-123!") &&
      !JSON.stringify(json).includes("Restore handbook") &&
      !JSON.stringify(json).includes("Page body survives"),
    "backup downloads with the page, and no plaintext inside",
  );

  // Same vault: everything is already there.
  await restore(a.page, a.nav, file, pw);
  await a.page
    .getByText(/Restored 0 items, 0 notes and 0 pages\. Skipped 2/)
    .waitFor({ timeout: 30_000 });
  check(true, "restoring into the same vault skips what is already there");

  // A new account on the same server: ids collide with A's, so new ones are used.
  const b = await account("backup-b");
  await restore(b.page, b.nav, file, "wrong password entirely");
  await b.page
    .getByText("That master password doesn't open this backup")
    .waitFor({ timeout: 30_000 });
  check(true, "a wrong backup password is refused");
  await b.page.getByPlaceholder("Master password used for this backup").fill(pw);
  await b.page.getByRole("button", { name: "Decrypt & restore" }).click();
  await b.page.getByText(/Restored 1 items, 1 notes and 1 pages/).waitFor({ timeout: 60_000 });
  check(true, "restores into a different account");

  await b.nav("/vault");
  await b.page.getByText("GitHub").first().click();
  await b.page.getByRole("button", { name: "Copy Password" }).click();
  let clip = "";
  for (let i = 0; i < 20 && clip !== "Restore-Me-123!"; i++) {
    await b.page.waitForTimeout(150);
    clip = await b.page.evaluate(() => navigator.clipboard.readText());
  }
  check(clip === "Restore-Me-123!", "restored password decrypts under the new account's key");
  await b.nav("/notes");
  await b.page.getByText("Restore runbook").click();
  await b.page.getByText("Secret steps inside").waitFor({ timeout: 10_000 });
  check(true, "restored note decrypts");
  await b.page.getByRole("link", { name: "Restore handbook" }).first().click();
  await b.page.getByText("Page body survives").waitFor({ timeout: 10_000 });
  check(true, "restored page decrypts under a new id and the new account's key");
  writeFileSync(file, "");
} catch (e) {
  for (const ctx of browser.contexts())
    for (const p of ctx.pages())
      await p
        .screenshot({ path: join(tmpdir(), `backup-failure-${Date.now()}.png`) })
        .catch(() => {});
  failures.push(e.message.split("\n")[0]);
  console.log(`✗ ${e.message.split("\n")[0]}`);
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`\n${failures.length} problem(s)`);
  process.exit(1);
}
console.log("\nBackup test passed.");
