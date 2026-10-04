// Browser test for: Paste anything, field suggestions, linked logins, several
// domains at once, Save & add another, the Authenticator page (including QR
// import) and passkey sign-in with a virtual authenticator.
//   pnpm dev   then   node tests/e2e/features.mjs [screenshotDir]
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const QRCode = require("qrcode");

const BASE = process.env.WEB_URL ?? "http://localhost:5180";
const OUT = process.argv[2] ?? "tests/e2e/screenshots";
mkdirSync(OUT, { recursive: true });
const email = `feat-${Date.now()}@example.com`;
const password = "Correct-Horse-Battery-Staple-42";
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const nav = async (path) => {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.waitForTimeout(300);
};
const dialog = () => page.getByRole("dialog");
const pasteInto = async (text) => {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await dialog()
    .getByPlaceholder(/github\.com {2}me@gmail\.com/)
    .click();
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(200);
};

try {
  await page.goto(`${BASE}/register`);
  await page.getByLabel("Name").fill("Feature Test");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Master password", { exact: true }).fill(password);
  await page.getByLabel("Confirm master password").fill(password);
  await page.getByRole("button", { name: "Create vault" }).click();
  await page.getByText("Everything sensitive, in one place.").waitFor({ timeout: 30_000 });

  // ── Paste anything picks the type and fills the fields ────────────────────
  await page.getByRole("button", { name: "New item" }).first().click();
  await pasteInto("namecheap.com  me@shimanto.dev  N4mecheap-Pass!");
  check(
    (await dialog().locator("#f-url").inputValue()) === "https://namecheap.com",
    "paste: website filled",
  );
  check(
    (await dialog().locator("#f-email").inputValue()) === "me@shimanto.dev",
    "paste: email filled",
  );
  check(
    (await dialog().locator("#f-password").inputValue()) === "N4mecheap-Pass!",
    "paste: password filled",
  );
  check(
    (await dialog().locator("#item-name").inputValue()) === "Namecheap",
    "paste: name from the site",
  );
  await shot("f01-smart-paste");
  await dialog().getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(/item=/);

  // ── Domains: suggestions, linked login, several at once ──────────────────
  await page.getByRole("button", { name: "New item" }).first().click();
  await dialog().getByRole("button", { name: "Domain" }).click();
  await dialog().locator("#f-domain").fill("first-domain.com");
  await dialog().locator("#f-registrar").fill("Namecheap");
  await dialog()
    .getByRole("button", { name: /Use Namecheap/ })
    .click();
  check(
    await dialog()
      .getByText(/Uses\s*Namecheap/)
      .isVisible(),
    "domain: links the saved Namecheap login",
  );
  check(
    (await dialog().locator("#f-password").count()) === 0,
    "domain: no password field to retype while linked",
  );
  await shot("f02-domain-linked");
  await dialog().getByRole("button", { name: "Save & add another" }).click();
  await page.waitForTimeout(800);
  check(
    (await dialog().locator("#f-registrar").inputValue()) === "Namecheap",
    "save & add another: registrar kept",
  );
  check(
    await dialog()
      .getByText(/Uses\s*Namecheap/)
      .isVisible(),
    "save & add another: login link kept",
  );
  check(
    (await dialog().locator("#f-domain").inputValue()) === "",
    "save & add another: domain cleared",
  );
  await dialog().locator("#f-domain").fill("second.com\nthird.io\nfourth.dev");
  await dialog().getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("3 domains saved").waitFor({ timeout: 15_000 });
  await nav("/vault?category=infrastructure");
  await page.waitForTimeout(800);
  for (const d of ["first-domain.com", "second.com", "third.io", "fourth.dev"])
    check(await page.getByText(d, { exact: true }).first().isVisible(), `domain saved: ${d}`);

  // The domain shows its login and can copy the shared password.
  await page.getByText("third.io", { exact: true }).first().click();
  await page.getByText("Signs in with").waitFor();
  await page.getByRole("button", { name: "Password", exact: true }).click();
  // The copy fetches and decrypts the login first.
  let clip = "";
  for (let i = 0; i < 20 && clip !== "N4mecheap-Pass!"; i++) {
    await page.waitForTimeout(150);
    clip = await page.evaluate(() => navigator.clipboard.readText());
  }
  check(clip === "N4mecheap-Pass!", "domain: copies the linked login's password");
  await shot("f03-domain-detail");

  // A new domain suggests the registrar used before.
  await page.getByRole("button", { name: "New item" }).first().click();
  await dialog().getByRole("button", { name: "Domain" }).click();
  check(
    await dialog().getByRole("button", { name: "Namecheap", exact: true }).isVisible(),
    "suggestion chip: registrar used before",
  );
  await dialog().getByRole("button", { name: "Cancel" }).click();

  // ── Authenticator: QR import and live codes ───────────────────────────────
  const qrPath = join(tmpdir(), `minions-qr-${Date.now()}.png`);
  await QRCode.toFile(
    qrPath,
    "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
  );
  await nav("/authenticator");
  await page.locator('input[type="file"]').setInputFiles(qrPath);
  await page.getByText("Added 1 account").waitFor({ timeout: 15_000 });
  await page.getByText("GitHub", { exact: true }).waitFor();
  const code = await page.locator("button[title='Copy code']").first().innerText();
  check(/^\d{3} \d{3}$/.test(code.trim()), `authenticator: live code shown (${code.trim()})`);
  await page.locator("button[title='Copy code']").first().click();
  check(
    /^\d{6}$/.test(await page.evaluate(() => navigator.clipboard.readText())),
    "authenticator: click copies the code",
  );
  await shot("f04-authenticator");

  // ── Passkey as the second factor ─────────────────────────────────────────
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await nav("/settings");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.getByPlaceholder("Master password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText(/Passkey added/).waitFor({ timeout: 20_000 });
  await shot("f05-passkey-added");

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Master password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Use a passkey" }).waitFor({ timeout: 30_000 });
  await shot("f06-passkey-2fa");
  await page.getByRole("button", { name: "Use a passkey" }).click();
  await page.getByText("Devices & sessions").first().waitFor({ timeout: 30_000 });
  check(true, "passkey: signed in with the passkey as second factor");
} catch (e) {
  await shot("zz-features-failure").catch(() => undefined);
  failures.push(`error: ${e.message.split("\n")[0]}`);
  console.log(`✗ ${e.message.split("\n")[0]}`);
} finally {
  await browser.close();
}

for (const e of errors) failures.push(`page error: ${e}`);
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nFeature test passed.");
