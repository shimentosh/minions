// Loads the built extension into Chromium and exercises it against a local
// login page and the running API.
//   pnpm --filter @minions/extension build && node tests/e2e/extension.mjs

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const API = process.env.API_URL ?? "http://localhost:4600";
const BUILT = resolve("apps/extension/dist");
const email = `ext-${Date.now()}@example.com`;
const password = "Correct-Horse-Battery-Staple-42";
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};

// A login page the content script will see.
const page = `<!doctype html><title>Acme</title><form id=f action="/done" method=post>
<input name=username id=u autocomplete=username><input type=password name=password id=p><button id=go>Sign in</button></form>`;
const site = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(req.url === "/done" ? "<!doctype html><title>Welcome</title><p>Signed in</p>" : page);
}).listen(5199);

// Register through the real web client code path is covered by smoke.mjs;
// here the extension signs in to an account created in the web app's way.
const core = await import("../../packages/core/dist/index.js");
{
  const userId = crypto.randomUUID();
  const vaultId = crypto.randomUUID();
  const keys = await core.createAccountKeys(password, userId, vaultId, {
    ...core.DEFAULT_KDF,
    memory: 19456,
    iterations: 2,
    salt: core.toBase64(core.randomBytes(16)),
  });
  const res = await fetch(`${API}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-minions-client": "extension" },
    body: JSON.stringify({
      email,
      name: "Ext Test",
      userId,
      vaultId,
      authKey: keys.authKey,
      kdf: keys.kdf,
      protectedUserKey: keys.protectedUserKey,
      protectedVaultKey: keys.protectedVaultKey,
      device: { clientDeviceId: crypto.randomUUID(), name: "setup", kind: "extension" },
    }),
  });
  if (res.status !== 201) throw new Error(`register ${res.status}`);
}

// The shipped extension relies on activeTab, which Chrome grants when the user
// clicks the toolbar button. Playwright cannot click it, so the test loads a
// copy whose manifest adds "tabs" to stand in for that grant. The shipped
// manifest itself must not ask for it.
const shipped = JSON.parse(readFileSync(join(BUILT, "manifest.json"), "utf8"));
check(
  !shipped.permissions.includes("tabs") &&
    !shipped.host_permissions.some((h) => h.includes("<all_urls>") || h.startsWith("*://")),
  "shipped manifest has no tabs or broad host permissions",
);
check(
  shipped.content_scripts.every((c) => c.all_frames === false),
  "content script runs in the top frame only",
);
const EXT = mkdtempSync(join(tmpdir(), "minions-ext-build-"));
cpSync(BUILT, EXT, { recursive: true });
writeFileSync(
  join(EXT, "manifest.json"),
  JSON.stringify({ ...shipped, permissions: [...shipped.permissions, "tabs"] }),
);

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "minions-ext-")), {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const extId = new URL(sw.url()).host;
  // Lets the test read the clipboard back from its own page; the extension never reads it.
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:5199",
  });
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const msg = (m) => popup.evaluate((req) => chrome.runtime.sendMessage(req), m);

  const first = await msg({ type: "state" });
  if (!first?.ok) console.log("state response:", JSON.stringify(first));
  check(first?.data?.status === "signed-out", "starts signed out");
  await popup.getByPlaceholder("you@example.com").fill(email);
  await popup.locator('input[type="password"]').fill(password);
  await popup.getByRole("button", { name: "Sign in" }).click();
  await popup.getByPlaceholder("Search vault…").waitFor({ timeout: 30_000 });
  check((await msg({ type: "state" })).data.status === "unlocked", "signs in and unlocks");

  // Key material is in memory-only session storage, never in local storage.
  const local = await popup.evaluate(() => chrome.storage.local.get(null));
  check(
    Object.keys(local).every((k) => k === "deviceId"),
    "nothing but the device id in chrome.storage.local",
  );

  // Submitting a login form offers to save it.
  const site1 = await ctx.newPage();
  await site1.goto("http://localhost:5199/login");
  await site1.fill("#u", "wile@acme.test");
  await site1.fill("#p", "Beep-Beep-123!");
  await site1.click("#go");
  await site1.waitForLoadState();
  let pending = await msg({ type: "pendingSave" });
  for (let i = 0; i < 25 && !pending.data; i++) {
    await new Promise((r) => setTimeout(r, 200));
    pending = await msg({ type: "pendingSave" });
  }
  check(
    pending.data?.host === "localhost" && pending.data?.username === "wile@acme.test",
    "detects the submitted login",
  );
  check(
    !("password" in (pending.data ?? {})),
    "the pending prompt does not expose the password to the page",
  );
  const saved = await msg({ type: "resolveSave", id: pending.data.id, action: "save" });
  check(saved.data === "saved", "saves the login after confirmation");

  // The saved login fills the same site.
  const site2 = await ctx.newPage();
  await site2.goto("http://localhost:5199/login");
  const tabId = await popup.evaluate(
    async () => (await chrome.tabs.query({ url: "http://localhost:5199/login" })).at(-1).id,
  );
  const match = await msg({ type: "match", tabId });
  check(match.data.items.length === 1, "finds the matching login for the site");
  const fill = await msg({ type: "fill", tabId, itemId: match.data.items[0].id });
  check(fill.ok, "fills");
  check(
    (await site2.inputValue("#u")) === "wile@acme.test" &&
      (await site2.inputValue("#p")) === "Beep-Beep-123!",
    "username and password filled into the page",
  );

  // Content scripts cannot use privileged messages.
  const fromPage = await site2.evaluate(
    () =>
      new Promise((r) => {
        try {
          chrome.runtime.sendMessage({ type: "copy", itemId: "x", field: "password" }, r);
        } catch {
          r("blocked");
        }
      }),
  );
  check(
    fromPage === "blocked" || fromPage?.ok === false || fromPage === undefined,
    "a web page cannot ask for secrets",
  );

  // A login for one site is never filled into another, even by an explicit request.
  const other = await ctx.newPage();
  await other.goto("http://127.0.0.1:5199/login");
  const otherTab = await popup.evaluate(
    async () => (await chrome.tabs.query({ url: "http://127.0.0.1:5199/login" })).at(-1).id,
  );
  const wrongFill = await msg({ type: "fill", tabId: otherTab, itemId: match.data.items[0].id });
  check(
    wrongFill.ok === false && (await other.inputValue("#p")) === "",
    "refuses to fill a login into a different site",
  );

  // Malformed messages are refused.
  const bad = await msg({ type: "fill", tabId: "1; drop", itemId: "../../x" });
  check(bad.ok === false, "malformed messages are refused");

  // "Never for this site" stops further prompts for that host.
  await other.fill("#u", "coyote@acme.test");
  await other.fill("#p", "Another-Pass-456!");
  await other.click("#go");
  await other.waitForLoadState();
  let p2 = await msg({ type: "pendingSave" });
  for (let i = 0; i < 25 && !p2.data; i++) {
    await new Promise((r) => setTimeout(r, 200));
    p2 = await msg({ type: "pendingSave" });
  }
  check(p2.data?.host === "127.0.0.1", "offers to save on a second site");
  await msg({ type: "resolveSave", id: p2.data.id, action: "never" });
  await other.goto("http://127.0.0.1:5199/login");
  await other.fill("#u", "coyote@acme.test");
  await other.fill("#p", "Third-Pass-789!");
  await other.click("#go");
  await other.waitForLoadState();
  await new Promise((r) => setTimeout(r, 1500));
  check(!(await msg({ type: "pendingSave" })).data, "never asks again after Never for this site");
  const localAfter = await popup.evaluate(() => chrome.storage.local.get(null));
  check(
    JSON.stringify(localAfter).includes("127.0.0.1") &&
      !JSON.stringify(localAfter).includes("coyote") &&
      !JSON.stringify(localAfter).includes("Pass-"),
    "the never-save list holds hostnames only",
  );

  // A copied secret is wiped from the clipboard by the background, popup or not.
  await site2.bringToFront();
  await site2.evaluate(() => navigator.clipboard.writeText("Copied-Secret-For-Clear-Test"));
  await msg({ type: "clipboardWritten" });
  const before = await site2.evaluate(() => navigator.clipboard.readText());
  await new Promise((r) => setTimeout(r, 35_000));
  await site2.bringToFront();
  const after = await site2.evaluate(() => navigator.clipboard.readText());
  check(
    before === "Copied-Secret-For-Clear-Test" && after === "",
    "clears a copied secret from the clipboard after 30 s",
  );

  await msg({ type: "lock" });
  check((await msg({ type: "state" })).data.status === "locked", "locks independently");
  const afterLock = await msg({ type: "match", tabId });
  check(afterLock.ok === false, "nothing is readable while locked");
} finally {
  await ctx.close();
  site.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nExtension test passed.");
