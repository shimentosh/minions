// End-to-end test of team workspaces in the web app, with two real browsers.
//   pnpm dev   (API on :4600, web on :5180)
//   node tests/e2e/workspaces.mjs [screenshotDir]
// Owner creates a workspace, invites a member, the member joins, the owner
// confirms them (handing over the workspace key), shares one login with them,
// the member reveals it, and the owner revokes it again.
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";

// Invitations need a verified email. The real link flow is covered by
// apps/api/test/email-verification.test.ts; here the two throwaway accounts
// are marked verified directly in the development database.
const { Client } = createRequire(new URL("../../apps/api/package.json", import.meta.url))("pg");
const DATABASE_URL =
  process.env.DATABASE_URL ??
  readFileSync(new URL("../../apps/api/.env", import.meta.url), "utf8").match(
    /^DATABASE_URL=(.+)$/m,
  )?.[1];
async function markVerified(email) {
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    await db.query('UPDATE users SET "emailVerifiedAt" = now() WHERE email = $1', [email]);
  } finally {
    await db.end();
  }
}

const BASE = process.env.WEB_URL ?? "http://localhost:5180";
const OUT = process.argv[2] ?? "tests/e2e/screenshots";
mkdirSync(OUT, { recursive: true });

const stamp = Date.now();
const password = "Correct-Horse-Battery-Staple-42";
const SECRET = `Team-Pw-${stamp}!`;
const errors = [];
const step = (name) => console.log(`• ${name}`);

const browser = await chromium.launch();

async function person(label, name, email) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
      errors.push(`${label} console: ${m.text()}`);
  });
  const nav = async (path) => {
    await page.evaluate((to) => {
      window.history.pushState({}, "", to);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, path);
    await page.waitForTimeout(250);
  };
  const shot = (n) => page.screenshot({ path: `${OUT}/ws-${n}.png` });
  await page.goto(`${BASE}/register`);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Master password", { exact: true }).fill(password);
  await page.getByLabel("Confirm master password").fill(password);
  await page.getByRole("button", { name: "Create vault" }).click();
  await page.getByRole("navigation", { name: "Vault" }).waitFor({ timeout: 30_000 });
  return { page, nav, shot, email };
}

try {
  step("register owner and member");
  const owner = await person("owner", "Fahim Owner", `owner-${stamp}@example.com`);
  const member = await person("member", "Rahim Member", `member-${stamp}@example.com`);
  await member.page.getByText("Confirm your email address").waitFor();
  await markVerified(owner.email);
  await markVerified(member.email);

  step("owner creates a workspace");
  await owner.nav("/workspaces");
  await owner.page.getByLabel("Workspace name").fill("Acme Agency");
  await owner.page.getByRole("button", { name: "Create" }).click();
  await owner.page.waitForURL(/\/w\/[0-9a-f-]+$/);
  const wsPath = new URL(owner.page.url()).pathname;

  step("owner invites the member");
  await owner.nav(`${wsPath}/members`);
  await owner.page.getByLabel("Email").fill(member.email);
  await owner.page.getByRole("button", { name: "Invite" }).click();
  await owner.page.getByText("Invited", { exact: true }).waitFor();

  step("member joins");
  await member.nav("/workspaces");
  await member.page.getByText("Acme Agency").waitFor({ timeout: 70_000 });
  await member.shot("01-invitation");
  await member.page.getByRole("button", { name: "Join" }).click();
  await member.page.getByText("Awaiting confirmation").waitFor();

  step("owner confirms the member (fingerprint)");
  await owner.nav("/workspaces");
  await owner.nav(`${wsPath}/members`);
  await owner.page.getByRole("button", { name: "Confirm", exact: true }).click();
  await owner.page.getByText(/^[0-9a-f]{8}( [0-9a-f]{8}){4}$/).waitFor();
  await owner.shot("02-confirm-fingerprint");
  await owner.page.getByRole("button", { name: "Fingerprints match, confirm" }).click();
  await owner.page.getByText("Needs confirmation").waitFor({ state: "detached" });

  step("owner adds a login shared with the member");
  await owner.nav(wsPath);
  await owner.page.getByRole("button", { name: "Add", exact: true }).click();
  await owner.page.getByRole("button", { name: "Login" }).click();
  await owner.page.getByLabel("Name", { exact: true }).fill("Client Facebook Ads");
  await owner.page.getByLabel("Website", { exact: true }).fill("https://business.facebook.com");
  await owner.page.getByLabel("Username", { exact: true }).fill("ads@acme.test");
  await owner.page.locator("#f-password").fill(SECRET);
  await owner.page.getByRole("radio", { name: /Specific members/ }).click();
  await owner.page.getByText("Rahim Member", { exact: true }).waitFor();
  await owner.shot("03-new-credential-access");
  // The member's row has a select: No access → Can use.
  const row = owner.page
    .locator("div")
    .filter({ hasText: /^RMRahim Member/ })
    .last();
  await row.getByRole("combobox").click();
  await owner.page.getByRole("option", { name: "Can use" }).click();
  await owner.page.getByRole("button", { name: "Save", exact: true }).click();
  await owner.page.waitForURL(/item=/);
  await owner.page.getByRole("heading", { name: "Client Facebook Ads" }).waitFor();
  await owner.page.getByText("Can use", { exact: true }).waitFor();
  await owner.shot("04-owner-detail");

  step("member sees and reveals it, read-only");
  await member.nav("/workspaces");
  await member.nav(wsPath);
  await member.page.getByText("Client Facebook Ads").first().click();
  await member.page.getByRole("heading", { name: "Client Facebook Ads" }).waitFor();
  await member.page.getByRole("button", { name: "Reveal Password" }).click();
  await member.page.getByText(SECRET, { exact: true }).waitFor();
  if (await member.page.getByRole("button", { name: "Edit" }).count())
    throw new Error("view-only member sees Edit");
  await member.shot("05-member-detail");

  step("member profile lists the credential");
  await owner.nav(`${wsPath}/members`);
  await owner.page.getByRole("link", { name: "Rahim Member" }).click();
  await owner.page.getByText("Password access · 1").waitFor();
  await owner.page.getByText("Client Facebook Ads").first().waitFor();
  await owner.shot("06-member-profile");

  step("audit log shows the member's reveal");
  await owner.nav(`${wsPath}/activity`);
  await owner.page
    .getByText(/revealed a field/)
    .first()
    .waitFor();
  if ((await owner.page.content()).includes(SECRET)) throw new Error("secret in audit page");
  await owner.shot("07-audit");

  step("owner revokes; member loses access");
  await owner.nav(wsPath);
  await owner.page.getByText("Client Facebook Ads").first().click();
  await owner.page.getByRole("button", { name: "Manage access" }).first().click();
  await owner.page.getByRole("radio", { name: /Only me/ }).click();
  await owner.page.getByText(/may have copied the password/).waitFor();
  await owner.shot("08-revoke");
  await owner.page.getByRole("button", { name: "Save access" }).click();
  await owner.page.getByText("Rotate key").waitFor();
  await owner.shot("09-rekey-banner");

  await member.nav("/workspaces");
  await member.nav(wsPath);
  await member.shot("10-member-after-revoke");
  await member.page.getByText("No credentials yet").waitFor();

  step("owner rotates the key");
  await owner.page.getByRole("button", { name: "Rotate key" }).click();
  await owner.page.getByText("Key rotated").waitFor();
  await owner.page.getByRole("button", { name: "Reveal Password" }).click();
  await owner.page.getByText(SECRET, { exact: true }).waitFor();

  if (errors.length) throw new Error(`Page errors:\n${errors.join("\n")}`);
  console.log("✓ workspaces e2e passed");
} catch (e) {
  console.error(e);
  if (errors.length) console.error(errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
