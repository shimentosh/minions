// Drives the real desktop app (release build) through WebView2's debugging port.
//   pnpm --filter @minions/desktop build   (API running)   node tests/e2e/desktop.mjs
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright";

const EXE = resolve("apps/desktop/src-tauri/target/release/minions-desktop.exe");
const PORT = 9333;
const email = `desktop-${Date.now()}@example.com`;
const password = "Correct-Horse-Battery-Staple-42";
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};

async function launch() {
  const proc = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
  });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 500));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => undefined);
  }
  if (!browser) throw new Error("Desktop app did not expose its webview");
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes("tauri.localhost"));
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw new Error("No app page in the webview");
  return { proc, browser, page };
}

async function quit(app) {
  await app.browser.close().catch(() => undefined);
  app.proc.kill();
  await new Promise((r) => setTimeout(r, 1500));
}

let app;
try {
  app = await launch();
  console.log(`  window: ${await app.page.title()} @ ${app.page.url()}`);
  await app.page.getByText("Sign in to your vault").waitFor({ timeout: 20_000 });
  await app.page.getByRole("button", { name: "Create a vault" }).click();
  await app.page.getByLabel("Name").fill("Desktop");
  await app.page.getByLabel("Email").fill(email);
  await app.page.getByLabel("Master password", { exact: true }).fill(password);
  await app.page.getByLabel("Confirm master password").fill(password);
  await app.page.getByRole("button", { name: "Create vault" }).click();
  await app.page.getByRole("navigation", { name: "Vault" }).waitFor({ timeout: 30_000 });
  check(true, "desktop app: registered and unlocked");
  await app.page.screenshot({
    path: process.argv[2]
      ? `${process.argv[2]}/d01-desktop.png`
      : "tests/e2e/screenshots/d01-desktop.png",
  });
  await quit(app);

  app = await launch();
  await app.page.getByText("Vault locked").waitFor({ timeout: 20_000 });
  check(true, "relaunch: still signed in (token from the OS keychain), vault locked");
  await app.page.getByLabel("Master password").fill(password);
  await app.page.getByRole("button", { name: "Unlock" }).click();
  await app.page.getByRole("navigation", { name: "Vault" }).waitFor({ timeout: 30_000 });
  check(true, "relaunch: unlocks with the master password");

  await app.page.getByRole("button", { name: "Account menu" }).click();
  await app.page.getByRole("menuitem", { name: "Sign out" }).click();
  await app.page.getByText("Sign in to your vault").waitFor({ timeout: 10_000 });
  await quit(app);

  app = await launch();
  await app.page.getByText("Sign in to your vault").waitFor({ timeout: 20_000 });
  check(true, "after sign-out the keychain entry is gone: relaunch asks to sign in");
  await quit(app);
  app = undefined;
} catch (e) {
  failures.push(e.message.split("\n")[0]);
  console.log(`✗ ${e.message.split("\n")[0]}`);
  if (app) await quit(app);
}
if (failures.length) {
  console.error(`\n${failures.length} problem(s)`);
  process.exit(1);
}
console.log("\nDesktop test passed.");
