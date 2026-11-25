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
const pages = {
  "/done": "<!doctype html><title>Welcome</title><p>Signed in</p>",
  // Change password: the username is in a hidden field, the new password is entered twice.
  "/change": `<!doctype html><title>Change</title><form action="/done" method=post>
<input type=text autocomplete=username value="wile@acme.test" hidden>
<input type=password id=cur autocomplete=current-password>
<input type=password id=new autocomplete=new-password>
<input type=password id=conf autocomplete=new-password><button id=go>Change</button></form>`,
  // Two-step sign-in: the username on one page, the password on the next.
  "/step1": `<!doctype html><title>Step 1</title><form action="/step2" method=get>
<input type=email name=email id=e autocomplete=username><button id=next>Next</button></form>`,
  "/step2": `<!doctype html><title>Step 2</title><form action="/done" method=post>
<input type=password id=p2 autocomplete=current-password><button id=go>Sign in</button></form>`,
  // Sign-up: email, a new password and its confirmation.
  "/signup": `<!doctype html><title>Join</title><form action="/done" method=post>
<input type=email id=se name=email><input type=password id=n1><input type=password id=n2>
<button id=join>Create account</button></form>`,
  // A sign-in that fails: the page stays, with the form and an error.
  "/fail": `<!doctype html><title>Fail</title><form onsubmit="event.preventDefault();document.getElementById('m').textContent='Wrong password'">
<input id=u autocomplete=username><input type=password id=p><button id=go>Sign in</button></form><p id=m></p>`,
  // A two-factor step.
  "/otp": `<!doctype html><title>Code</title><form action="/done" method=post>
<input id=code autocomplete=one-time-code inputmode=numeric><button id=verify>Verify</button></form>`,
};
const site = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(pages[new URL(req.url, "http://x").pathname] ?? page);
}).listen(5199);

// Register through the real web client code path is covered by smoke.mjs;
// here the extension signs in to an account created in the web app's way.
const core = await import("../../packages/core/dist/index.js");
const userId = crypto.randomUUID();
const vaultId = crypto.randomUUID();
{
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
  check(
    await popup.getByRole("button", { name: "Sign in with Minions app" }).isVisible(),
    "offers to sign in through the Minions app first",
  );
  await popup.getByRole("button", { name: "Use email and master password" }).click();
  await popup.getByPlaceholder("you@example.com").fill(email);
  await popup.locator('input[type="password"]').fill(password);
  await popup.getByRole("button", { name: "Sign in", exact: true }).click();
  await popup.getByPlaceholder("Search your vault…").waitFor({ timeout: 30_000 });
  check((await msg({ type: "state" })).data.status === "unlocked", "signs in and unlocks");

  // Key material is in memory-only session storage, never in local storage.
  const local = await popup.evaluate(() => chrome.storage.local.get(null));
  check(
    Object.keys(local).every((k) => k === "deviceId"),
    "nothing but the device id in chrome.storage.local",
  );
  // The checks below answer each offer themselves; automatic saving has its own checks.
  await popup.evaluate(() => chrome.storage.local.set({ settings: { autoSave: false } }));

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

  const waitPending = async (cond = () => true) => {
    let p = await msg({ type: "pendingSave" });
    for (let i = 0; i < 25 && !(p.data && cond(p.data)); i++) {
      await new Promise((r) => setTimeout(r, 200));
      p = await msg({ type: "pendingSave" });
    }
    return p.data;
  };

  // The menu under a login field offers the saved login; picking it fills the page.
  const site3 = await ctx.newPage();
  await site3.goto("http://localhost:5199/login");
  await site3.focus("#u");
  const menuShown = await site3
    .waitForSelector("#minions-fill-menu", { state: "attached", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(menuShown, "a menu with the saved login opens under the login field");
  check(
    await site3.evaluate(() => document.getElementById("minions-fill-menu")?.shadowRoot === null),
    "the page cannot read inside the menu",
  );
  // The Minions button inside the field: there on focus, and it brings a closed menu back.
  const iconBox = await site3
    .waitForSelector("#minions-field-icon", { state: "visible", timeout: 5000 })
    .then((h) => h.boundingBox())
    .catch(() => null);
  const fieldBox = await site3.locator("#u").boundingBox();
  check(
    !!iconBox &&
      !!fieldBox &&
      iconBox.x > fieldBox.x + fieldBox.width / 2 &&
      iconBox.x + iconBox.width <= fieldBox.x + fieldBox.width,
    "a Minions button sits inside the right edge of the login field",
  );
  await site3.keyboard.press("Escape");
  await site3.waitForSelector("#minions-fill-menu", { state: "detached", timeout: 3000 });
  if (iconBox)
    await site3.mouse.click(iconBox.x + iconBox.width / 2, iconBox.y + iconBox.height / 2);
  check(
    await site3
      .waitForSelector("#minions-fill-menu", { state: "attached", timeout: 3000 })
      .then(() => true)
      .catch(() => false),
    "clicking the button opens the menu again",
  );
  await site3.keyboard.press("ArrowDown");
  await site3.keyboard.press("Enter");
  await site3.waitForFunction(() => document.querySelector("#p").value !== "", null, {
    timeout: 5000,
  });
  check(
    (await site3.inputValue("#u")) === "wile@acme.test" &&
      (await site3.inputValue("#p")) === "Beep-Beep-123!" &&
      site3.url().endsWith("/login"),
    "picking it from the menu fills both fields without submitting",
  );
  await site3.close();

  // Changing a password: Minions offers to update the login with the new one.
  const change = await ctx.newPage();
  await change.goto("http://localhost:5199/change");
  await change.fill("#cur", "Beep-Beep-123!");
  await change.fill("#new", "Meep-Meep-456!");
  await change.fill("#conf", "Meep-Meep-456!");
  await change.click("#go");
  await change.waitForLoadState();
  const upd = await waitPending((d) => !!d.updateItemId);
  check(
    upd?.updateItemId === match.data.items[0].id && upd?.username === "wile@acme.test",
    "a password change offers to update the saved login",
  );
  check(
    await change
      .waitForSelector("#minions-save-prompt", { state: "attached", timeout: 5000 })
      .then(() => true)
      .catch(() => false),
    "the save prompt appears on the page after it navigates",
  );
  const updated = await msg({ type: "resolveSave", id: upd.id, action: "update" });
  check(updated.data === "updated", "updates the login after confirmation");
  await site2.goto("http://localhost:5199/login");
  await msg({ type: "fill", tabId, itemId: match.data.items[0].id });
  check(
    (await site2.inputValue("#p")) === "Meep-Meep-456!",
    "the new password is saved, not the current one or the confirmation",
  );
  await change.close();

  // Two-step sign-in: the username from the first page goes with the password from the second.
  const steps = await ctx.newPage();
  await steps.goto("http://localhost:5199/step1");
  await steps.fill("#e", "roadrunner@acme.test");
  await steps.click("#next");
  await steps.waitForURL(/step2/);
  await steps.fill("#p2", "Zoom-Zoom-789!");
  await steps.click("#go");
  await steps.waitForLoadState();
  const two = await waitPending((d) => d.username === "roadrunner@acme.test");
  check(
    two?.username === "roadrunner@acme.test" && !two?.updateItemId,
    "a two-step sign-in is saved with the username from step one",
  );
  if (two) await msg({ type: "resolveSave", id: two.id, action: "ignore" });
  await steps.close();

  // Sign-up: the menu offers the user's email, then a strong password for both fields.
  const menuOn = (p) =>
    p
      .waitForSelector("#minions-fill-menu", { state: "attached", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
  const join = await ctx.newPage();
  await join.goto("http://localhost:5199/signup");
  await join.focus("#se");
  check(await menuOn(join), "a sign-up email field offers the user's email");
  await join.keyboard.press("ArrowDown");
  await join.keyboard.press("Enter");
  await join.waitForFunction(() => document.querySelector("#se").value !== "", null, {
    timeout: 5000,
  });
  check((await join.inputValue("#se")) === email, "fills the account email");
  await join.focus("#n1");
  check(await menuOn(join), "a new-password field offers a strong password at once");
  await join.waitForTimeout(400);
  await join.keyboard.press("ArrowDown");
  await join.keyboard.press("Enter");
  await join.waitForFunction(() => document.querySelector("#n1").value !== "", null, {
    timeout: 5000,
  });
  const made = await join.inputValue("#n1");
  check(
    made.length >= 16 && (await join.inputValue("#n2")) === made,
    "the generated password fills the password and its confirmation",
  );
  await join.click("#join");
  await join.waitForLoadState();
  const joined = await waitPending((d) => d.username === email);
  check(joined?.username === email && !joined?.updateItemId, "offers to save the new account");
  if (joined) await msg({ type: "resolveSave", id: joined.id, action: "ignore" });
  await join.close();

  // A two-factor code field offers the code of the site's login.
  {
    const pre = await (
      await fetch(`${API}/auth/prelogin`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-minions-client": "web" },
        body: JSON.stringify({ email }),
      })
    ).json();
    const { authKey, stretchedKey } = await core.deriveMasterKeys(password, pre.kdf);
    const res = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-minions-client": "web" },
      body: JSON.stringify({
        email,
        authKey,
        device: { clientDeviceId: crypto.randomUUID(), name: "e2e otp", kind: "web" },
      }),
    });
    const cookie = res.headers.get("set-cookie").split(";")[0];
    const { keys } = await res.json();
    const uk = await core.unwrapKey(stretchedKey, keys.protectedUserKey, core.aad.userKey(userId));
    const vk = await core.unwrapKey(uk, keys.protectedVaultKey, core.aad.vaultKey(vaultId));
    const id = crypto.randomUUID();
    const secret = "JBSWY3DPEHPK3PXP";
    const created = await fetch(`${API}/vault/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-minions-client": "web", cookie },
      body: JSON.stringify({
        id,
        type: "LOGIN",
        name: "Acme 2FA",
        fields: [
          { key: "url", value: "http://localhost:5199", sensitive: false },
          { key: "username", value: "otp@acme.test", sensitive: false },
          {
            key: "password",
            value: await core.encryptString(vk, "Otp-Pass-1!", core.aad.field(id, "password")),
            sensitive: true,
          },
          {
            key: "totp",
            value: await core.encryptString(vk, secret, core.aad.field(id, "totp")),
            sensitive: true,
          },
        ],
      }),
    });
    check(created.status === 201, "test login with a 2FA secret created");
    const otp = await ctx.newPage();
    await otp.goto("http://localhost:5199/otp");
    check(await menuOn(otp), "a 2FA code field offers the code on its own, without a click");
    await otp.focus("#code");
    await otp.keyboard.press("ArrowDown");
    await otp.keyboard.press("Enter");
    await otp.waitForFunction(() => document.querySelector("#code").value !== "", null, {
      timeout: 5000,
    });
    const expected = (await core.generateTotp(secret)).code;
    check((await otp.inputValue("#code")) === expected, "fills the current 2FA code");
    await otp.close();

    // A login saved without a website, named like the site: offered, confirmed, then remembered.
    const loose = crypto.randomUUID();
    const made2 = await fetch(`${API}/vault/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-minions-client": "web", cookie },
      body: JSON.stringify({
        id: loose,
        type: "LOGIN",
        name: "Acme portal",
        fields: [
          { key: "username", value: "road@acme.test", sensitive: false },
          {
            key: "password",
            value: await core.encryptString(vk, "Loose-Pass-1!", core.aad.field(loose, "password")),
            sensitive: true,
          },
        ],
      }),
    });
    check(made2.status === 201, "test login without a website created");
    await ctx.route("https://login.acme.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: page }),
    );
    const acme = await ctx.newPage();
    await acme.goto("https://login.acme.test/");
    await acme.focus("#u");
    check(await menuOn(acme), "a login saved without a website is offered on its site");
    await acme.keyboard.press("ArrowDown");
    await acme.keyboard.press("Enter");
    await acme.waitForTimeout(300);
    check((await acme.inputValue("#p")) === "", "nothing is filled before the user confirms");
    await acme.keyboard.press("Enter");
    await acme
      .waitForFunction(() => document.querySelector("#p").value !== "", null, { timeout: 5000 })
      .catch(() => undefined);
    check(
      (await acme.inputValue("#u")) === "road@acme.test" &&
        (await acme.inputValue("#p")) === "Loose-Pass-1!",
      "after confirming, it fills",
    );
    const acmeTab = await popup.evaluate(
      async () => (await chrome.tabs.query({ url: "https://login.acme.test/*" })).at(-1).id,
    );
    const acmeMatch = await msg({ type: "match", tabId: acmeTab });
    check(
      acmeMatch.data?.items.some((i) => i.id === loose),
      "and the site is remembered on the login for next time",
    );
    await acme.close();
  }

  // "Remember on this computer": the vault opens again after a browser restart.
  await popup.evaluate(() =>
    chrome.storage.local.set({ settings: { autoSave: false, rememberDevice: true } }),
  );
  await msg({ type: "rememberDevice", on: true });
  await popup.evaluate(() => chrome.storage.session.clear());
  check(
    (await msg({ type: "state" })).data.status === "unlocked",
    "remembered on this computer: unlocked again after a restart",
  );
  await msg({ type: "lock" });
  await popup.evaluate(() => chrome.storage.session.clear());
  check(
    (await msg({ type: "state" })).data.status === "locked",
    "after a lock it is forgotten: a restart asks again",
  );
  await popup.evaluate(() => chrome.storage.local.set({ settings: { autoSave: false } }));
  await msg({ type: "unlock", password });

  // Saved automatically: a new login once the sign-in goes through, with an Undo.
  await popup.evaluate(() => chrome.storage.local.remove("settings"));
  const auto = await ctx.newPage();
  await auto.goto("http://localhost:5199/login");
  await auto.fill("#u", "auto@acme.test");
  await auto.fill("#p", "Auto-Pass-1!");
  await auto.click("#go");
  await auto.waitForLoadState();
  let autoSaved = false;
  for (let i = 0; i < 30 && !autoSaved; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const m = await msg({ type: "match", tabId });
    autoSaved = !!m.data?.items.some((i) => i.username === "auto@acme.test");
  }
  check(autoSaved, "a new login is saved on its own after a sign-in that works");
  check(
    await auto
      .waitForSelector("#minions-save-prompt", { state: "attached", timeout: 5000 })
      .then(() => true)
      .catch(() => false),
    "and the page says so (with an Undo)",
  );
  await auto.close();

  // A sign-in that fails stays on the form: nothing is saved without asking.
  const fail = await ctx.newPage();
  await fail.goto("http://localhost:5199/fail");
  await fail.fill("#u", "typo@acme.test");
  await fail.fill("#p", "Wrong-Pass-1!");
  await fail.click("#go");
  await new Promise((r) => setTimeout(r, 5000));
  const stillPending = (await msg({ type: "pendingSave" })).data;
  const typoSaved = (await msg({ type: "match", tabId })).data?.items.some(
    (i) => i.username === "typo@acme.test",
  );
  check(
    stillPending?.username === "typo@acme.test" && !typoSaved,
    "a failed sign-in is not saved on its own; Minions asks instead",
  );
  if (stillPending) await msg({ type: "resolveSave", id: stillPending.id, action: "ignore" });
  await fail.close();

  // Turned off in settings: no menu on fields, no offer to save.
  await popup.evaluate(() =>
    chrome.storage.local.set({ settings: { inlineMenu: false, offerSave: false } }),
  );
  const quiet = await ctx.newPage();
  await quiet.goto("http://localhost:5199/login");
  await quiet.focus("#u");
  check(!(await menuOn(quiet)), "no menu when suggestions are turned off");
  await quiet.fill("#u", "quiet@acme.test");
  await quiet.fill("#p", "Quiet-Pass-1!");
  await quiet.click("#go");
  await quiet.waitForLoadState();
  await new Promise((r) => setTimeout(r, 1500));
  check(
    (await msg({ type: "pendingSave" })).data?.username !== "quiet@acme.test",
    "no offer to save when saving is turned off",
  );
  await popup.evaluate(() => chrome.storage.local.set({ settings: { autoSave: false } }));
  await quiet.close();

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

  // ─── Stays signed in ───────────────────────────────────────────────────────
  // A browser restart empties session storage; the sign-in itself persists.
  await popup.evaluate(() => chrome.storage.session.clear());
  const restarted = (await msg({ type: "state" })).data;
  check(
    restarted.status === "locked" && restarted.email === email,
    "after a restart it is still signed in, and locked",
  );

  // ─── Sign in with the Minions app ──────────────────────────────────────────
  // Any other site talking the bridge protocol gets no answer.
  const helloFrom = (p) =>
    p.evaluate(
      () =>
        new Promise((done) => {
          const on = (e) => {
            if (e.data?.source === "minions-extension" && e.data.type === "hello") {
              window.removeEventListener("message", on);
              done(e.data);
            }
          };
          window.addEventListener("message", on);
          window.postMessage({ source: "minions-app", type: "ping" }, location.origin);
          setTimeout(() => done(null), 1500);
        }),
    );
  check((await helloFrom(site2)) === null, "the app bridge does not answer other sites");

  const WEB = restarted.webUrl;
  const webUp = await fetch(WEB)
    .then((r) => r.ok)
    .catch(() => false);
  if (!webUp) console.log(`- skipped app-bridge checks: no web app at ${WEB}`);
  else {
    const appPage = await ctx.newPage();
    await appPage.goto(WEB);
    const hello = await helloFrom(appPage);
    check(
      hello?.status === "locked" &&
        hello?.linkedUserId === userId &&
        !!hello?.device?.clientDeviceId,
      "the app sees the extension: locked, signed in to this account",
    );

    // The web app's side, done here directly: a web session opens one for the extension.
    const pre = await (
      await fetch(`${API}/auth/prelogin`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-minions-client": "web" },
        body: JSON.stringify({ email }),
      })
    ).json();
    const { authKey, stretchedKey } = await core.deriveMasterKeys(password, pre.kdf);
    const loginRes = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-minions-client": "web" },
      body: JSON.stringify({
        email,
        authKey,
        device: { clientDeviceId: crypto.randomUUID(), name: "e2e web", kind: "web" },
      }),
    });
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];
    const { keys } = await loginRes.json();
    const userKey = await core.unwrapKey(
      stretchedKey,
      keys.protectedUserKey,
      core.aad.userKey(userId),
    );
    const vk = await core.unwrapKey(userKey, keys.protectedVaultKey, core.aad.vaultKey(vaultId));
    const linkRes = await fetch(`${API}/vault/extension-link`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-minions-client": "web", cookie },
      body: JSON.stringify({ device: { ...hello.device, kind: "extension" } }),
    });
    const { token } = await linkRes.json();
    const link = {
      source: "minions-app",
      type: "link",
      nonce: hello.nonce,
      token,
      userId,
      vaultId,
      email,
      autoLockMinutes: 15,
      vaultKey: core.toBase64(vk),
      privateKey: null,
    };
    const postLink = (data) =>
      appPage.evaluate(
        (d) =>
          new Promise((done) => {
            const on = (e) => {
              if (e.data?.source === "minions-extension" && e.data.type === "linked") {
                window.removeEventListener("message", on);
                done(e.data);
              }
            };
            window.addEventListener("message", on);
            window.postMessage(d, location.origin);
            setTimeout(() => done(null), 10_000);
          }),
        data,
      );
    const linked = await postLink(link);
    check(linked?.ok === true, "the app connects the extension without a password");
    check((await msg({ type: "state" })).data.status === "unlocked", "connected and unlocked");
    check(
      (await msg({ type: "match", tabId })).data?.items.length >= 1,
      "reads the vault after connecting",
    );
    const totps = await msg({ type: "totpList" });
    check(totps.ok && Array.isArray(totps.data), "lists 2FA codes");

    // A nonce works once: a replayed link is refused and leaves the session alone.
    const replay = await postLink(link);
    check(replay?.ok === false, "a replayed link is refused");
    check(
      (await msg({ type: "state" })).data.status === "unlocked",
      "a refused link changes nothing",
    );
    await appPage.close();
  }
} finally {
  await ctx.close();
  site.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nExtension test passed.");
