// End-to-end smoke test of the web app against a running API.
//   pnpm dev   (API on :4600, web on :5180)
//   node tests/e2e/smoke.mjs [screenshotDir]
// Registers a throwaway account, exercises the main flows, and fails on any
// uncaught page error or failed assertion.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.WEB_URL ?? "http://localhost:5180";
const OUT = process.argv[2] ?? "tests/e2e/screenshots";
mkdirSync(OUT, { recursive: true });

const email = `e2e-${Date.now()}@example.com`;
const password = "Correct-Horse-Battery-Staple-42";
const errors = [];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
    errors.push(`console: ${m.text()}`);
});

// Client-side navigation. A full reload (page.goto) locks the vault, because
// the vault key only ever lives in memory.
const nav = async (path) => {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.waitForTimeout(150);
};
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const step = (name) => console.log(`• ${name}`);

try {
  step("register");
  await page.goto(`${BASE}/register`);
  await page.getByLabel("Name").fill("Shimanto Test");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Master password", { exact: true }).fill(password);
  await page.getByLabel("Confirm master password").fill(password);
  await shot("01-register");
  await page.getByRole("button", { name: "Create vault" }).click();
  await page.getByText("Everything sensitive, in one place.").waitFor({ timeout: 30_000 });
  await shot("02-dashboard-empty");

  step("create project");
  await nav("/projects");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Name", { exact: true }).fill("ClipMesh");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/projects\/.+/);

  step("create login via editor");
  await page.getByRole("button", { name: "New item" }).first().click();
  await page.getByRole("button", { name: "Login" }).click();
  await page.getByLabel("Name", { exact: true }).fill("GitHub");
  await page.getByLabel("Website", { exact: true }).fill("https://github.com/login");
  await page.getByLabel("Username", { exact: true }).fill("octocat");
  await page.locator("#f-password").fill("hunter2");
  await shot("03-editor-login");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(/item=/);
  await page.getByRole("heading", { name: "GitHub" }).waitFor();

  step("reveal + copy password");
  await page.getByRole("button", { name: "Reveal Password" }).click();
  await page.getByText("hunter2", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Copy Password" }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  if (clip !== "hunter2") throw new Error(`clipboard had ${JSON.stringify(clip)}`);
  await shot("04-item-detail");

  step("quick capture");
  await page.getByRole("button", { name: "Quick capture" }).first().click();
  await page
    .getByPlaceholder(/Cloudflare production token/)
    .fill("Cloudflare production token for ClipMesh cfut_9f8e7d6c5b4a3F2E1D0C9B8A7f6e5d4c3b2a");
  await page.getByText("Cloudflare", { exact: true }).first().waitFor();
  await page.waitForTimeout(900);
  await shot("05-quick-capture");
  await page.getByRole("button", { name: "Review & save" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(/item=/);

  step("vault list + search");
  await nav("/vault");
  await page.getByText("GitHub").first().waitFor();
  await page.getByPlaceholder(/Search all items/).fill("cloudflare");
  await page.waitForTimeout(800);
  await shot("06-vault-search");

  step("security center");
  await nav("/security");
  await page.getByText("Security health").first().waitFor();
  await page.getByText(/Weak password: GitHub/).waitFor();
  await shot("07-security");

  step("notes");
  await nav("/notes");
  await page.getByRole("button", { name: "New note" }).first().click();
  await page.waitForURL(/note=/);
  await page.getByPlaceholder("Untitled").fill("Server runbook");
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("Restart with systemctl restart app");
  await page.getByText(/Saved/).waitFor({ timeout: 10_000 });
  await shot("08-notes");

  step("command palette");
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Search the vault/).fill("git");
  await page.waitForTimeout(500);
  await shot("09-palette");
  await page.keyboard.press("Escape");

  for (const [path, name] of [
    ["/", "10-dashboard"],
    ["/activity", "11-activity"],
    ["/devices", "12-devices"],
    ["/generator", "13-generator"],
    ["/import", "14-import"],
    ["/cleanup", "15-cleanup"],
    ["/settings", "16-settings"],
  ]) {
    step(`page ${path}`);
    await nav(path);
    await page.waitForTimeout(900);
    await shot(name);
  }

  step("lock and unlock");
  await page.getByRole("button", { name: "Lock vault" }).first().click();
  await page.getByText("Vault locked").waitFor();
  await shot("17-locked");
  await page.getByLabel("Master password").fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
  // Back where the user was, with the vault open again.
  await page.getByText("Devices & sessions").first().waitFor({ timeout: 30_000 });

  step("dark mode");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.goto(`${BASE}/vault`);
  await page.evaluate(() => {
    localStorage.setItem("minions-theme", "dark");
  });
  await page.reload();
  await page.getByLabel("Master password").fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByText("GitHub").first().waitFor({ timeout: 30_000 });
  await shot("18-vault-dark");

  step("mobile");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/`);
  await page.getByLabel("Master password").fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.waitForTimeout(2500);
  await shot("19-mobile-dashboard");
} catch (e) {
  await shot("zz-failure").catch(() => undefined);
  errors.push(`assertion: ${e.message}`);
} finally {
  await browser.close();
}

if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("\nSmoke test passed.");
