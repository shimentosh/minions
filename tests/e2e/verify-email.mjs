// The email verification link in the web app: banner while unverified, the
// link page confirms, the token leaves the address bar, a reused link fails.
//   pnpm dev   (API on :4600, web on :5180)
//   node tests/e2e/verify-email.mjs
// Locally no email is sent (no RESEND_API_KEY), so the test stores a link it
// knows in the development database, exactly as the API would (SHA-256 only).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const BASE = process.env.WEB_URL ?? "http://localhost:5180";
const { Client } = createRequire(new URL("../../apps/api/package.json", import.meta.url))("pg");
const DATABASE_URL =
  process.env.DATABASE_URL ??
  readFileSync(new URL("../../apps/api/.env", import.meta.url), "utf8").match(
    /^DATABASE_URL=(.+)$/m,
  )?.[1];

const email = `verify-${Date.now()}@example.com`;
const password = "Correct-Horse-Battery-Staple-42";
const errors = [];
const step = (s) => console.log(`• ${s}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

try {
  step("register: banner asks to confirm");
  await page.goto(`${BASE}/register`);
  await page.getByLabel("Name").fill("Verify Test");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Master password", { exact: true }).fill(password);
  await page.getByLabel("Confirm master password").fill(password);
  await page.getByRole("button", { name: "Create vault" }).click();
  await page.getByText("Confirm your email address").waitFor({ timeout: 30_000 });

  step("open the link");
  const token = randomBytes(32).toString("base64url");
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query(
    `INSERT INTO email_verifications (id, "userId", "tokenHash", "expiresAt")
     SELECT $1, id, $2, now() + interval '1 hour' FROM users WHERE email = $3`,
    [randomUUID(), createHash("sha256").update(token).digest("hex"), email],
  );
  await db.end();
  await page.goto(`${BASE}/verify-email#${token}`);
  await page.getByText("Email confirmed").waitFor({ timeout: 15_000 });
  if (page.url().includes(token)) throw new Error("token still in the address bar");

  step("a reused link fails");
  // A fresh load, as when the link is opened again from the email.
  await page.goto("about:blank");
  await page.goto(`${BASE}/verify-email#${token}`);
  await page.getByText("Could not confirm").waitFor({ timeout: 15_000 });

  step("banner is gone after unlocking");
  await page.goto(`${BASE}/`);
  await page.getByLabel("Master password").fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByText("Everything sensitive, in one place.").waitFor({ timeout: 30_000 });
  if (await page.getByText("Confirm your email address").count())
    throw new Error("banner still shown after verification");
} catch (e) {
  errors.push(`assertion: ${e.message}`);
} finally {
  await browser.close();
}

if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("\nEmail verification test passed.");
