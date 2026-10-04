// Share links, end to end: owner creates, a stranger (no account) opens.
//   pnpm dev   then   node tests/e2e/share.mjs [screenshotDir]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.WEB_URL ?? "http://localhost:5180";
const OUT = process.argv[2] ?? "tests/e2e/screenshots";
mkdirSync(OUT, { recursive: true });
const pw = "Correct-Horse-Battery-Staple-42";
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};

const browser = await chromium.launch();
try {
  const owner = await (
    await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    })
  ).newPage();
  await owner.goto(`${BASE}/register`);
  await owner.getByLabel("Name").fill("Share Owner");
  await owner.getByLabel("Email").fill(`share-${Date.now()}@example.com`);
  await owner.getByLabel("Master password", { exact: true }).fill(pw);
  await owner.getByLabel("Confirm master password").fill(pw);
  await owner.getByRole("button", { name: "Create vault" }).click();
  await owner.getByText("Everything sensitive, in one place.").waitFor({ timeout: 30_000 });

  // A login with 2FA.
  await owner.getByRole("button", { name: "New item" }).first().click();
  const d = owner.getByRole("dialog");
  await owner.evaluate(
    (t) => navigator.clipboard.writeText(t),
    "Website: staging.example.com\nUser: team@example.com\nPass: Sh4red-Staging-Pass!\n2FA: JBSWY3DPEHPK3PXP",
  );
  await d.getByPlaceholder(/github\.com {2}me@gmail\.com/).click();
  await owner.keyboard.press("Control+V");
  await d.locator("#item-name").fill("Staging admin");
  await d.getByRole("button", { name: "Save", exact: true }).click();
  await owner.waitForURL(/item=/);

  // Share it: one view, with live 2FA.
  await owner.getByRole("button", { name: "Share" }).click();
  const sd = owner.getByRole("dialog");
  await sd.getByText("Include live 2FA codes").click();
  await owner.screenshot({ path: `${OUT}/s01-share-dialog.png` });
  await sd.getByRole("button", { name: "Create link" }).click();
  const url = await sd.locator("input[readonly]").inputValue({ timeout: 15_000 });
  check(/\/s\/[0-9a-f-]{36}#[A-Za-z0-9_-]{43}$/.test(url), "link has the key after #");
  await owner.screenshot({ path: `${OUT}/s02-share-link.png` });

  // A stranger: separate browser profile, no account.
  const stranger = await (
    await browser.newContext({
      viewport: { width: 1000, height: 800 },
      permissions: ["clipboard-read", "clipboard-write"],
    })
  ).newPage();
  await stranger.goto(url);
  await stranger.getByText("Someone shared a secret with you").waitFor({ timeout: 15_000 });
  check(!stranger.url().includes("#"), "the key is removed from the address bar");
  check(await stranger.getByText("Can be opened once").isVisible(), "shows it is one-time");
  await stranger.getByRole("button", { name: /Reveal/ }).click({ timeout: 10_000 });
  await stranger.getByText("Staging admin").waitFor({ timeout: 15_000 });
  await stranger.getByRole("button", { name: "Show" }).first().click({ timeout: 10_000 });
  check(await stranger.getByText("Sh4red-Staging-Pass!").isVisible(), "stranger sees the password");
  check(await stranger.getByText("team@example.com").isVisible(), "stranger sees the username");
  const code = (await stranger.locator("button[title='Copy code']").innerText()).trim();
  check(/^\d{3} \d{3}$/.test(code), `stranger sees a live 2FA code (${code})`);
  check(await stranger.getByText("Shared by Share Owner").isVisible(), "shows who shared it");
  await stranger.screenshot({ path: `${OUT}/s03-recipient.png` });

  // The link is now used up.
  const again = await (await browser.newContext()).newPage();
  await again.goto(url);
  await again.getByText("already been opened").waitFor({ timeout: 15_000 });
  check(true, "a second visit gets nothing");
  await again.screenshot({ path: `${OUT}/s04-used.png` });

  // Owner sees it as used, viewed once.
  await owner.getByRole("button", { name: "Done" }).click();
  await owner.evaluate(() => {
    window.history.pushState({}, "", "/shares");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await owner.getByText("Used up").waitFor({ timeout: 10_000 });
  check(await owner.getByText(/Opened 1 of 1 time/).isVisible(), "owner sees it opened once");

  // A text secret with a passphrase.
  await owner.getByRole("button", { name: "Share a secret" }).click();
  const td = owner.getByRole("dialog");
  await td.locator("#st-title").fill("Wifi");
  await td.locator("#st-text").fill("office-wifi-pass-123");
  await td.getByText("Also require a passphrase").click();
  await td.locator("#st-pass").fill("blue horse");
  await td.getByRole("button", { name: "Create link" }).click();
  const url2 = await td.locator("input[readonly]").inputValue({ timeout: 15_000 });
  const s2 = await (await browser.newContext()).newPage();
  await s2.goto(url2);
  await s2.getByPlaceholder("Passphrase from the sender").fill("red horse");
  await s2.getByRole("button", { name: /Reveal/ }).click();
  await s2.getByText("Wrong passphrase").waitFor({ timeout: 15_000 });
  check(true, "wrong passphrase is refused");
  await s2.getByPlaceholder("Passphrase from the sender").fill("blue horse");
  await s2.getByRole("button", { name: /Reveal/ }).click();
  await s2.getByText("Wifi").waitFor({ timeout: 15_000 });
  await s2.getByRole("button", { name: "Show" }).click();
  check(await s2.getByText("office-wifi-pass-123").isVisible(), "right passphrase opens it");
} catch (e) {
  failures.push(e.message.split("\n")[0]);
  console.log(`✗ ${e.message.split("\n")[0]}`);
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`\n${failures.length} problem(s)`);
  process.exit(1);
}
console.log("\nShare test passed.");
