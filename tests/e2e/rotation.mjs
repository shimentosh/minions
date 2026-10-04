// Vault-key rotation through the real web client: create a login and a note,
// change the vault key in Settings, then lock, unlock and read both back.
//   pnpm dev   (API on :4600, web on :5180)
//   node tests/e2e/rotation.mjs
import { chromium } from "playwright";

const BASE = process.env.WEB_URL ?? "http://localhost:5180";
const email = `rot-${Date.now()}@example.com`;
const password = "Correct-Horse-Battery-Staple-42";
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
  await page.waitForTimeout(150);
};
const step = (s) => console.log(`• ${s}`);

try {
  step("register");
  await page.goto(`${BASE}/register`);
  await page.getByLabel("Name").fill("Rotation Test");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Master password", { exact: true }).fill(password);
  await page.getByLabel("Confirm master password").fill(password);
  await page.getByRole("button", { name: "Create vault" }).click();
  await page.getByText("Everything sensitive, in one place.").waitFor({ timeout: 30_000 });

  step("create a login and a note");
  await nav("/vault");
  await page.getByRole("button", { name: "New item" }).first().click();
  await page.getByRole("button", { name: "Login" }).click();
  await page.getByLabel("Name", { exact: true }).fill("GitHub");
  await page.getByLabel("Website", { exact: true }).fill("https://github.com/login");
  await page.getByLabel("Username", { exact: true }).fill("octocat");
  await page.locator("#f-password").fill("rotate-me-Secret-77");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(/item=/);
  const itemUrl = new URL(page.url());
  await nav("/notes");
  await page.getByRole("button", { name: "New note" }).first().click();
  await page.waitForURL(/note=/);
  const noteUrl = new URL(page.url());
  await page.getByPlaceholder("Untitled").fill("Runbook");
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("note body survives rotation");
  await page.getByText(/Saved/).waitFor({ timeout: 10_000 });

  step("change the vault key");
  await nav("/settings");
  await page.locator("#vk-password").fill(password);
  await page.getByRole("button", { name: "Change vault key" }).click();
  await page.getByText("Vault key changed").first().waitFor({ timeout: 60_000 });

  step("lock, unlock, read back");
  await page.getByRole("button", { name: "Lock vault" }).first().click();
  await page.getByText("Vault locked").waitFor();
  await page.getByLabel("Master password").fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByText("Vault key").first().waitFor({ timeout: 30_000 });
  await nav(`${itemUrl.pathname}${itemUrl.search}`);
  await page.getByRole("heading", { name: "GitHub" }).waitFor();
  await page.getByRole("button", { name: "Reveal Password" }).click();
  await page.getByText("rotate-me-Secret-77", { exact: true }).waitFor();
  await nav(`${noteUrl.pathname}${noteUrl.search}`);
  await page.getByText("note body survives rotation").waitFor({ timeout: 10_000 });
} catch (e) {
  errors.push(`assertion: ${e.message}`);
} finally {
  await browser.close();
}

if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("\nRotation test passed.");
