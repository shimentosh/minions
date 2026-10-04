// Fills an existing account's vault with realistic demo data, so every page
// (dashboard, lists, projects, security center, activity, devices) has
// something to show.
//
//   MINIONS_PASSWORD='master password' pnpm seed:demo
//
// Env:
//   MINIONS_EMAIL     account to fill (default admin@minions.local)
//   MINIONS_PASSWORD  its master password (required)
//   API_URL           default http://localhost:4600
//   SEED_RESET=1      wipe the vault's items, notes, projects, collections and
//                     tags first (otherwise a non-empty vault is left alone)
//
// Items and notes are created through the API exactly as the web client does
// (secrets encrypted on this side with the vault key). Afterwards the script
// backdates timestamps and adds usage, activity and devices directly in the
// database, which a real client could only produce over weeks of use.
// The data is fake: test card numbers, random keys, made-up hosts.

import { createHash, randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
const apiRequire = createRequire(resolve(root, "apps/api/package.json"));
const pg = apiRequire("pg");
// Prisma stores UTC in "timestamp without time zone" columns.
pg.defaults.parseInputDatesAsUTC = true;
const { Client } = pg;

const API = process.env.API_URL ?? "http://localhost:4600";
const EMAIL = process.env.MINIONS_EMAIL ?? "admin@minions.local";
const PASSWORD = process.env.MINIONS_PASSWORD;
const RESET = process.env.SEED_RESET === "1";
if (!PASSWORD) {
  console.error("Set MINIONS_PASSWORD to the account's master password.");
  process.exit(1);
}

const DATABASE_URL =
  process.env.DATABASE_URL ??
  readFileSync(resolve(root, "apps/api/.env"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("DATABASE_URL="))
    ?.slice("DATABASE_URL=".length)
    .trim();
if (!DATABASE_URL) throw new Error("DATABASE_URL not found (apps/api/.env)");

// ─── helpers ────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();
const ago = (ms) => new Date(now - ms);
const daysFromNow = (d) => new Date(now + d * DAY).toISOString().slice(0, 10);
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const alnum = (n) => {
  const cs = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(nodeRandomBytes(n), (b) => cs[b % cs.length]).join("");
};
const hex = (n) =>
  nodeRandomBytes(Math.ceil(n / 2))
    .toString("hex")
    .slice(0, n);
const base32 = (n) => {
  const cs = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return Array.from(nodeRandomBytes(n), (b) => cs[b % 32]).join("");
};
const strong = () => core.generatePassword();
const recoveryCodes = (n = 10) => Array.from({ length: n }, () => `${hex(4)}-${hex(4)}`).join("\n");
const sshKey = () =>
  `-----BEGIN OPENSSH PRIVATE KEY-----\n${Array.from({ length: 6 }, () => alnum(70)).join("\n")}\n-----END OPENSSH PRIVATE KEY-----`;
const sshPub = (comment) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${alnum(43)} ${comment}`;

let token;
async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-minions-client": "extension",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  }
}

// ─── sign in ────────────────────────────────────────────────────────────────

const pre = await api("POST", "/auth/prelogin", { email: EMAIL });
const { authKey, stretchedKey } = await core.deriveMasterKeys(PASSWORD, pre.kdf);
const seedDeviceId = randomUUID();
const login = await api("POST", "/auth/login", {
  email: EMAIL,
  authKey,
  device: { clientDeviceId: seedDeviceId, name: "Demo seed", kind: "extension" },
});
if (login.status !== "ok") throw new Error("This account has 2FA on; turn it off to seed.");
token = login.token;
const unlocked = await api("POST", "/vault/unlock", { authKey });
const keys = unlocked.keys ?? login.keys;
const userKey = await core.unwrapKey(
  stretchedKey,
  keys.protectedUserKey,
  core.aad.userKey(keys.userId),
);
const vaultKey = await core.unwrapKey(
  userKey,
  keys.protectedVaultKey,
  core.aad.vaultKey(keys.vaultId),
);
const { userId, vaultId } = keys;
console.log(`Signed in as ${EMAIL}`);

const DEMO_DEVICE_NAMES = [
  "iPhone 16 · Safari",
  "MacBook Air · Chrome extension",
  "Minions Desktop · Windows",
  "Office PC · Edge",
  "Old ThinkPad · Firefox",
];

const db = new Client({ connectionString: DATABASE_URL });
await db.connect();
await db.query("SET TIME ZONE 'UTC'");

if (RESET) {
  for (const t of ["vault_items", "notes", "projects", "collections", "tags"])
    await db.query(`DELETE FROM ${t} WHERE "vaultId" = $1`, [vaultId]);
  await db.query(`DELETE FROM security_findings WHERE "vaultId" = $1`, [vaultId]);
  await db.query(
    `DELETE FROM activity_logs WHERE "userId" = $1 AND ("itemId" IS NOT NULL OR action LIKE 'note.%')`,
    [userId],
  );
  await db.query(`DELETE FROM devices WHERE "userId" = $1 AND name = ANY($2)`, [
    userId,
    DEMO_DEVICE_NAMES,
  ]);
  console.log("Wiped existing vault contents");
} else {
  // Existing items stay; only a second run of this script is refused.
  const seeded = await db.query(
    `SELECT 1 FROM projects WHERE "vaultId" = $1 AND name = 'Acme Storefront'`,
    [vaultId],
  );
  if (seeded.rowCount) {
    console.error(
      "Demo data is already in this vault. Re-run with SEED_RESET=1 to wipe the vault and reseed.",
    );
    await cleanupSeedDevice();
    await db.end();
    process.exit(1);
  }
}

// ─── projects & collections ─────────────────────────────────────────────────

const projectDefs = [
  [
    "Acme Storefront",
    "Client e-commerce site: Next.js, Stripe, Postgres on DigitalOcean.",
    "#3b82f6",
  ],
  ["Northwind CRM", "Internal CRM for Northwind Traders. Retainer, staging + prod.", "#8b5cf6"],
  ["Minions Platform", "This app. API, web, extension and desktop builds.", "#10b981"],
  ["Recipe Box", "Side project: recipe sharing app with AI suggestions.", "#f59e0b"],
  ["Home Lab", "Raspberry Pi cluster, NAS, router and smart home.", "#ef4444"],
  ["Personal", "Personal accounts, banking and subscriptions.", "#64748b"],
];
const P = {};
for (const [name, description, color] of projectDefs)
  P[name] = (await api("POST", "/projects", { name, description, color })).id;

const collectionDefs = [
  ["Work", "Everything for client and company work.", "#0ea5e9"],
  ["Personal", "My own accounts.", "#a855f7"],
  ["Family", "Shared with family: Wi-Fi, streaming, utilities.", "#ec4899"],
  ["Finance", "Cards, banks, payments.", "#22c55e"],
  ["Dev tools", "SaaS and developer tooling.", "#f97316"],
  ["Archive", "Old accounts kept for reference.", "#78716c"],
];
const C = {};
for (const [name, description, color] of collectionDefs)
  C[name] = (await api("POST", "/collections", { name, description, color })).id;
console.log(`Created ${projectDefs.length} projects, ${collectionDefs.length} collections`);

// ─── items ──────────────────────────────────────────────────────────────────

// Shared on purpose so the security center reports reuse.
const reusedPw = "Sunshine2019!";
const weakPw = ["password123", "qwerty12", "dhaka1234", "letmein"];

const items = [];
/**
 * age: days since created. used: [accessCount, hours since last use] or null for never.
 * pwAge: days since the password last changed (defaults to age).
 */
function item(type, name, values, opts = {}) {
  items.push({ id: randomUUID(), type, name, values, ...opts });
}

// Logins
item(
  "LOGIN",
  "GitHub",
  {
    url: "https://github.com/login",
    username: "admin-dev",
    email: "admin@minions.local",
    password: strong(),
    totp: base32(32),
  },
  {
    project: "Minions Platform",
    collection: "Dev tools",
    tags: ["dev", "2fa"],
    favorite: true,
    age: 210,
    used: [64, 2],
  },
);
item(
  "LOGIN",
  "Google Workspace",
  {
    url: "https://accounts.google.com",
    email: "admin@acme-store.com",
    password: strong(),
    totp: base32(32),
    recovery_email: "backup@minions.local",
  },
  {
    project: "Acme Storefront",
    collection: "Work",
    tags: ["work", "2fa"],
    favorite: true,
    age: 180,
    used: [41, 5],
  },
);
item(
  "LOGIN",
  "Gmail (personal)",
  {
    url: "https://mail.google.com",
    email: "admin.personal@gmail.com",
    password: strong(),
    recovery_phone: "+880 1711-000000",
  },
  {
    project: "Personal",
    collection: "Personal",
    tags: ["email"],
    favorite: true,
    age: 400,
    used: [88, 1],
  },
);
item(
  "LOGIN",
  "Figma",
  { url: "https://www.figma.com/login", email: "admin@minions.local", password: strong() },
  {
    project: "Acme Storefront",
    collection: "Dev tools",
    tags: ["design"],
    age: 150,
    used: [19, 30],
  },
);
item(
  "LOGIN",
  "Notion",
  {
    url: "https://www.notion.so/login",
    email: "admin@minions.local",
    password: strong(),
    totp: base32(32),
  },
  { collection: "Work", tags: ["docs", "2fa"], age: 160, used: [27, 20] },
);
item(
  "LOGIN",
  "Slack — Acme",
  { url: "https://acme-store.slack.com", email: "admin@acme-store.com", password: strong() },
  { project: "Acme Storefront", collection: "Work", tags: ["chat"], age: 175, used: [35, 9] },
);
item(
  "LOGIN",
  "Linear",
  { url: "https://linear.app/login", email: "admin@minions.local", password: strong() },
  { project: "Minions Platform", collection: "Dev tools", tags: ["dev"], age: 90, used: [22, 26] },
);
item(
  "LOGIN",
  "Vercel",
  {
    url: "https://vercel.com/login",
    username: "admin-dev",
    email: "admin@minions.local",
    password: strong(),
    totp: base32(32),
  },
  {
    project: "Recipe Box",
    collection: "Dev tools",
    tags: ["hosting", "2fa"],
    age: 120,
    used: [12, 50],
  },
);
item(
  "LOGIN",
  "Netlify",
  { url: "https://app.netlify.com", email: "admin@minions.local", password: weakPw[0] },
  {
    project: "Recipe Box",
    collection: "Dev tools",
    tags: ["hosting"],
    age: 300,
    used: [3, 24 * 70],
  },
);
item(
  "LOGIN",
  "DigitalOcean",
  {
    url: "https://cloud.digitalocean.com/login",
    email: "admin@acme-store.com",
    password: strong(),
    totp: base32(32),
  },
  {
    project: "Acme Storefront",
    collection: "Work",
    tags: ["hosting", "2fa"],
    favorite: true,
    age: 260,
    used: [31, 6],
  },
);
item(
  "LOGIN",
  "Facebook",
  { url: "https://www.facebook.com", email: "admin.personal@gmail.com", password: reusedPw },
  {
    project: "Personal",
    collection: "Personal",
    tags: ["social"],
    age: 900,
    pwAge: 700,
    used: [9, 24 * 4],
  },
);
item(
  "LOGIN",
  "Instagram",
  { url: "https://www.instagram.com/accounts/login", username: "admin.snaps", password: reusedPw },
  {
    project: "Personal",
    collection: "Personal",
    tags: ["social"],
    age: 850,
    pwAge: 650,
    used: [14, 24 * 2],
  },
);
item(
  "LOGIN",
  "LinkedIn",
  { url: "https://www.linkedin.com/login", email: "admin.personal@gmail.com", password: reusedPw },
  {
    project: "Personal",
    collection: "Personal",
    tags: ["social", "work"],
    age: 600,
    pwAge: 600,
    used: [6, 24 * 12],
  },
);
item(
  "LOGIN",
  "X (Twitter)",
  { url: "https://x.com/login", username: "admin_dev", password: strong() },
  { project: "Personal", collection: "Personal", tags: ["social"], age: 500, used: [11, 24 * 3] },
);
item(
  "LOGIN",
  "Netflix",
  { url: "https://www.netflix.com/login", email: "family@minions.local", password: weakPw[1] },
  {
    collection: "Family",
    tags: ["streaming", "family"],
    favorite: true,
    age: 700,
    pwAge: 700,
    used: [25, 24 * 1],
  },
);
item(
  "LOGIN",
  "Spotify Family",
  { url: "https://accounts.spotify.com", email: "family@minions.local", password: strong() },
  { collection: "Family", tags: ["streaming", "family"], age: 450, used: [8, 24 * 6] },
);
item(
  "LOGIN",
  "Amazon",
  {
    url: "https://www.amazon.com/ap/signin",
    email: "admin.personal@gmail.com",
    password: strong(),
  },
  { project: "Personal", collection: "Personal", tags: ["shopping"], age: 380, used: [7, 24 * 9] },
);
item(
  "LOGIN",
  "Daraz",
  {
    url: "https://member.daraz.com.bd/user/login",
    email: "admin.personal@gmail.com",
    password: weakPw[2],
  },
  {
    project: "Personal",
    collection: "Personal",
    tags: ["shopping"],
    age: 520,
    pwAge: 520,
    used: [4, 24 * 20],
  },
);
item(
  "LOGIN",
  "Apple ID",
  {
    url: "https://appleid.apple.com",
    email: "admin.personal@gmail.com",
    password: strong(),
    totp: base32(32),
  },
  { project: "Personal", collection: "Personal", tags: ["2fa"], age: 640, used: [5, 24 * 15] },
);
item(
  "LOGIN",
  "Microsoft account",
  { url: "https://login.live.com", email: "admin@outlook.com", password: strong() },
  { project: "Personal", collection: "Personal", age: 560, used: [3, 24 * 30] },
);
item(
  "LOGIN",
  "Dropbox",
  {
    url: "https://www.dropbox.com/login",
    email: "admin.personal@gmail.com",
    password: "Dropbox#2021",
  },
  { collection: "Archive", tags: ["storage"], age: 1300, pwAge: 1300, used: null },
);
item(
  "LOGIN",
  "Zoom",
  { url: "https://zoom.us/signin", email: "admin@acme-store.com", password: strong() },
  {
    project: "Northwind CRM",
    collection: "Work",
    tags: ["meetings"],
    age: 240,
    used: [16, 24 * 2],
  },
);
item(
  "LOGIN",
  "Discord",
  { url: "https://discord.com/login", username: "admin#4521", password: strong() },
  { project: "Personal", collection: "Personal", tags: ["chat"], age: 330, used: [10, 24 * 5] },
);
item(
  "LOGIN",
  "Steam",
  { url: "https://store.steampowered.com/login", username: "admin_plays", password: weakPw[3] },
  { collection: "Personal", tags: ["games"], age: 1100, pwAge: 1100, used: null },
);
item(
  "LOGIN",
  "Home router admin",
  { url: "http://192.168.0.1", username: "admin", password: "admin" },
  { project: "Home Lab", collection: "Family", tags: ["network"], age: 820, used: [2, 24 * 95] },
);
item(
  "LOGIN",
  "Northwind staging admin",
  {
    url: "https://staging.northwind-crm.test/admin",
    username: "admin",
    email: "admin@northwind.test",
    password: strong(),
  },
  { project: "Northwind CRM", collection: "Work", tags: ["staging"], age: 2, used: [3, 12] },
);

// API keys
item(
  "API_KEY",
  "OpenAI — Recipe Box",
  {
    provider: "OpenAI",
    api_key: `sk-proj-${alnum(48)}`,
    environment: "Production",
    status: "Active",
    base_url: "https://api.openai.com/v1",
    last_rotated: daysFromNow(-40),
  },
  {
    project: "Recipe Box",
    collection: "Dev tools",
    tags: ["ai"],
    favorite: true,
    age: 110,
    used: [29, 4],
  },
);
item(
  "API_KEY",
  "Anthropic — Minions",
  {
    provider: "Anthropic",
    api_key: `sk-ant-api03-${alnum(80)}`,
    environment: "Development",
    status: "Active",
    docs_url: "https://docs.anthropic.com",
  },
  { project: "Minions Platform", collection: "Dev tools", tags: ["ai"], age: 1, used: [6, 3] },
);
item(
  "API_KEY",
  "Stripe live keys",
  {
    provider: "Stripe",
    api_key: `pk_live_${alnum(40)}`,
    api_secret: `sk_live_${alnum(40)}`,
    environment: "Production",
    status: "Active",
    permissions: "Full access",
  },
  {
    project: "Acme Storefront",
    collection: "Finance",
    tags: ["payments", "prod"],
    favorite: true,
    age: 200,
    used: [18, 26],
  },
);
item(
  "API_KEY",
  "Stripe test keys",
  {
    provider: "Stripe",
    api_key: `pk_test_${alnum(40)}`,
    api_secret: `sk_test_${alnum(40)}`,
    environment: "Development",
    status: "Active",
  },
  {
    project: "Acme Storefront",
    collection: "Dev tools",
    tags: ["payments"],
    age: 200,
    used: [44, 8],
  },
);
item(
  "API_KEY",
  "SendGrid",
  {
    provider: "SendGrid",
    api_key: `SG.${alnum(22)}.${alnum(43)}`,
    environment: "Production",
    status: "Rotating",
    expires_at: daysFromNow(12),
  },
  {
    project: "Northwind CRM",
    collection: "Work",
    tags: ["email", "prod"],
    age: 340,
    used: [5, 24 * 8],
  },
);
item(
  "API_KEY",
  "Twilio",
  {
    provider: "Twilio",
    api_key: `AC${hex(32)}`,
    api_secret: hex(32),
    environment: "Production",
    status: "Active",
  },
  { project: "Northwind CRM", collection: "Work", tags: ["sms"], age: 280, used: [2, 24 * 40] },
);
item(
  "API_KEY",
  "Google Maps",
  {
    provider: "Google Cloud",
    api_key: `AIza${alnum(35)}`,
    environment: "Production",
    status: "Active",
    permissions: "Maps JavaScript API, Places API",
  },
  { project: "Acme Storefront", collection: "Dev tools", tags: ["maps"], age: 190, used: null },
);
item(
  "API_KEY",
  "GitHub personal access token",
  {
    provider: "GitHub",
    api_key: `ghp_${alnum(36)}`,
    status: "Active",
    permissions: "repo, workflow, read:org",
    expires_at: daysFromNow(6),
  },
  { project: "Minions Platform", collection: "Dev tools", tags: ["dev"], age: 84, used: [21, 30] },
);
item(
  "API_KEY",
  "Mapbox (old)",
  {
    provider: "Mapbox",
    api_key: `pk.${alnum(60)}`,
    status: "Expired",
    expires_at: daysFromNow(-25),
  },
  { project: "Recipe Box", collection: "Archive", tags: ["maps"], age: 420, used: null },
);
item(
  "API_KEY",
  "DeepSeek",
  { provider: "DeepSeek", api_key: `sk-${hex(32)}`, environment: "Development", status: "Active" },
  { project: "Minions Platform", collection: "Dev tools", tags: ["ai"], age: 30, used: [9, 48] },
);

// Secrets, env files, webhooks
item(
  "SECRET",
  "JWT signing secret (prod)",
  {
    provider: "Acme API",
    secret: alnum(64),
    environment: "Production",
    status: "Active",
    last_rotated: daysFromNow(-200),
  },
  {
    project: "Acme Storefront",
    collection: "Work",
    tags: ["prod", "auth"],
    age: 200,
    used: [4, 24 * 10],
  },
);
item(
  "SECRET",
  "Session secret (staging)",
  { provider: "Northwind API", secret: alnum(48), environment: "Staging", status: "Active" },
  { project: "Northwind CRM", collection: "Work", tags: ["staging"], age: 150, used: [2, 24 * 20] },
);
item(
  "ENVIRONMENT",
  "acme-storefront .env.production",
  {
    environment: "Production",
    "var.DATABASE_URL": `postgresql://acme:${alnum(24)}@db.acme-store.internal:5432/acme`,
    "var.STRIPE_SECRET_KEY": `sk_live_${alnum(40)}`,
    "var.NEXTAUTH_SECRET": alnum(44),
    "var.REDIS_URL": `redis://:${alnum(20)}@cache.acme-store.internal:6379`,
    "var.SENTRY_DSN": `https://${hex(32)}@o123456.ingest.sentry.io/456789`,
  },
  {
    project: "Acme Storefront",
    collection: "Work",
    tags: ["prod", "env"],
    favorite: true,
    age: 140,
    used: [23, 18],
  },
);
item(
  "ENVIRONMENT",
  "northwind-api .env.staging",
  {
    environment: "Staging",
    "var.DATABASE_URL": `postgresql://nw:${alnum(24)}@staging-db.northwind.test:5432/crm`,
    "var.JWT_SECRET": alnum(48),
    "var.SMTP_PASSWORD": alnum(20),
  },
  {
    project: "Northwind CRM",
    collection: "Work",
    tags: ["staging", "env"],
    age: 95,
    used: [11, 24 * 3],
  },
);
item(
  "ENVIRONMENT",
  "recipe-box .env.local",
  {
    environment: "Development",
    "var.OPENAI_API_KEY": `sk-proj-${alnum(48)}`,
    "var.SUPABASE_URL": "https://xyzcompany.supabase.co",
    "var.SUPABASE_ANON_KEY": alnum(120),
  },
  { project: "Recipe Box", collection: "Dev tools", tags: ["env"], age: 60, used: [15, 24 * 2] },
);
item(
  "WEBHOOK",
  "Stripe webhook — orders",
  {
    provider: "Stripe",
    endpoint: "https://acme-store.com/api/webhooks/stripe",
    secret: `whsec_${alnum(32)}`,
    events: "checkout.session.completed, invoice.paid",
    environment: "Production",
  },
  {
    project: "Acme Storefront",
    collection: "Finance",
    tags: ["payments", "prod"],
    age: 198,
    used: [3, 24 * 25],
  },
);
item(
  "WEBHOOK",
  "GitHub deploy webhook",
  {
    provider: "GitHub",
    endpoint: "https://deploy.minions.dev/hooks/github",
    secret: hex(40),
    events: "push, release",
    environment: "Production",
  },
  { project: "Minions Platform", collection: "Dev tools", tags: ["ci"], age: 45, used: null },
);

// Authenticators & recovery codes
item(
  "TOTP",
  "AWS root account MFA",
  { issuer: "Amazon Web Services", account: "root@acme-store.com", totp: base32(32) },
  {
    project: "Acme Storefront",
    collection: "Work",
    tags: ["2fa", "aws"],
    age: 250,
    used: [17, 24 * 4],
  },
);
item(
  "TOTP",
  "Cloudflare 2FA",
  { issuer: "Cloudflare", account: "admin@minions.local", totp: base32(32) },
  {
    project: "Minions Platform",
    collection: "Dev tools",
    tags: ["2fa"],
    age: 230,
    used: [13, 24 * 6],
  },
);
item(
  "TOTP",
  "bKash app PIN 2FA",
  { issuer: "bKash", account: "+880 1711-000000", totp: base32(32) },
  { project: "Personal", collection: "Finance", tags: ["2fa"], age: 300, used: [8, 24 * 7] },
);
item(
  "RECOVERY_CODE",
  "GitHub recovery codes",
  { service: "GitHub", account: "admin-dev", codes: recoveryCodes(16) },
  {
    project: "Minions Platform",
    collection: "Dev tools",
    tags: ["2fa", "recovery"],
    age: 210,
    used: null,
  },
);
item(
  "RECOVERY_CODE",
  "Google recovery codes",
  { service: "Google", account: "admin@acme-store.com", codes: recoveryCodes(10) },
  {
    project: "Acme Storefront",
    collection: "Work",
    tags: ["2fa", "recovery"],
    age: 180,
    used: [1, 24 * 60],
  },
);

// Infrastructure
item(
  "SERVER",
  "acme-web-01 (prod)",
  {
    host: "159.65.12.34",
    port: "22",
    username: "deploy",
    private_key: sshKey(),
    public_key: sshPub("deploy@acme-web-01"),
    provider: "DigitalOcean",
    environment: "Production",
  },
  {
    project: "Acme Storefront",
    collection: "Work",
    tags: ["prod", "ssh"],
    favorite: true,
    age: 255,
    used: [38, 7],
  },
);
item(
  "SERVER",
  "northwind-staging",
  {
    host: "staging.northwind-crm.test",
    port: "2222",
    username: "ubuntu",
    password: strong(),
    provider: "Hetzner",
    environment: "Staging",
  },
  {
    project: "Northwind CRM",
    collection: "Work",
    tags: ["staging", "ssh"],
    age: 130,
    used: [12, 24 * 2],
  },
);
item(
  "SERVER",
  "Raspberry Pi — homeassistant",
  { host: "192.168.0.50", port: "22", username: "pi", password: "raspberry" },
  {
    project: "Home Lab",
    collection: "Family",
    tags: ["homelab"],
    age: 600,
    pwAge: 600,
    used: [5, 24 * 18],
  },
);
item(
  "SSH_KEY",
  "Personal SSH key (ed25519)",
  {
    private_key: sshKey(),
    passphrase: strong(),
    public_key: sshPub("admin@laptop"),
    fingerprint: `SHA256:${alnum(43)}`,
    key_type: "ed25519",
  },
  {
    project: "Personal",
    collection: "Dev tools",
    tags: ["ssh"],
    favorite: true,
    age: 400,
    used: [20, 24 * 1],
  },
);
item(
  "SSH_KEY",
  "GitHub Actions deploy key",
  {
    private_key: sshKey(),
    public_key: sshPub("deploy@github-actions"),
    fingerprint: `SHA256:${alnum(43)}`,
    key_type: "ed25519",
  },
  {
    project: "Acme Storefront",
    collection: "Work",
    tags: ["ci", "ssh"],
    age: 250,
    used: [2, 24 * 50],
  },
);
item(
  "DATABASE",
  "Acme Postgres (prod)",
  {
    engine: "PostgreSQL",
    host: "db.acme-store.internal",
    port: "5432",
    database: "acme",
    username: "acme_app",
    password: strong(),
    connection_string: `postgresql://acme_app:${alnum(24)}@db.acme-store.internal:5432/acme?sslmode=require`,
    ssl: "true",
    environment: "Production",
  },
  {
    project: "Acme Storefront",
    collection: "Work",
    tags: ["prod", "db"],
    favorite: true,
    age: 255,
    used: [27, 10],
  },
);
item(
  "DATABASE",
  "Acme Redis cache",
  {
    engine: "Redis",
    host: "cache.acme-store.internal",
    port: "6379",
    password: alnum(32),
    environment: "Production",
  },
  {
    project: "Acme Storefront",
    collection: "Work",
    tags: ["prod", "db"],
    age: 240,
    used: [6, 24 * 9],
  },
);
item(
  "DATABASE",
  "Northwind MySQL (staging)",
  {
    engine: "MySQL",
    host: "staging-db.northwind.test",
    port: "3306",
    database: "crm",
    username: "crm_staging",
    password: "Northwind2023",
    environment: "Staging",
  },
  {
    project: "Northwind CRM",
    collection: "Work",
    tags: ["staging", "db"],
    age: 410,
    pwAge: 410,
    used: [9, 24 * 3],
  },
);
item(
  "DATABASE",
  "Recipe Box Mongo Atlas",
  {
    engine: "MongoDB",
    host: "cluster0.ab12c.mongodb.net",
    database: "recipes",
    username: "recipe_app",
    password: strong(),
    environment: "Development",
  },
  { project: "Recipe Box", collection: "Dev tools", tags: ["db"], age: 70, used: [7, 24 * 4] },
);
item(
  "CLOUD",
  "AWS IAM — deploy user",
  {
    provider: "AWS",
    account_id: "4821-3390-1177",
    access_key: `AKIA${alnum(16).toUpperCase()}`,
    secret_key: alnum(40),
    region: "ap-southeast-1",
    console_url: "https://console.aws.amazon.com",
  },
  {
    project: "Acme Storefront",
    collection: "Work",
    tags: ["aws", "ci"],
    age: 250,
    pwAge: 420,
    used: [14, 24 * 2],
  },
);
item(
  "CLOUD",
  "Cloudflare API token",
  {
    provider: "Cloudflare",
    account_id: hex(32),
    secret_key: alnum(40),
    console_url: "https://dash.cloudflare.com",
  },
  {
    project: "Minions Platform",
    collection: "Dev tools",
    tags: ["dns"],
    usedBy: ["Acme Storefront", "Recipe Box", "Home Lab"],
    age: 220,
    used: [19, 24 * 1],
  },
);
item(
  "CLOUD",
  "GCP service account — Northwind",
  {
    provider: "GCP",
    account_id: "northwind-crm-prod",
    access_key: `${randInt(100000000000, 999999999999)}`,
    secret_key: alnum(64),
    region: "asia-south1",
  },
  { project: "Northwind CRM", collection: "Work", tags: ["gcp"], age: 160, used: null },
);
item(
  "DOMAIN",
  "acme-store.com",
  {
    domain: "acme-store.com",
    registrar: "Namecheap",
    url: "https://www.namecheap.com/myaccount/login",
    username: "acme-owner",
    password: strong(),
    expires_at: daysFromNow(18),
    nameservers: "ns1.cloudflare.com, ns2.cloudflare.com",
  },
  { project: "Acme Storefront", collection: "Work", tags: ["dns"], age: 340, used: [3, 24 * 14] },
);
item(
  "DOMAIN",
  "minions.dev",
  { domain: "minions.dev", registrar: "Cloudflare Registrar", expires_at: daysFromNow(240) },
  {
    project: "Minions Platform",
    collection: "Dev tools",
    tags: ["dns"],
    age: 95,
    used: [2, 24 * 22],
  },
);
item(
  "DOMAIN",
  "admin.me (portfolio)",
  {
    domain: "admin.me",
    registrar: "Porkbun",
    url: "https://porkbun.com/account/login",
    username: "admin",
    password: strong(),
    expires_at: daysFromNow(-3),
  },
  { project: "Personal", collection: "Personal", tags: ["dns"], age: 730, used: null },
);

// Financial
item(
  "CREDIT_CARD",
  "Visa Platinum",
  {
    cardholder: "ADMIN MINIONS",
    number: "4242 4242 4242 4242",
    exp_month: "08",
    exp_year: "2029",
    cvv: "123",
    pin: "4821",
    issuer: "City Bank",
  },
  {
    project: "Personal",
    collection: "Finance",
    tags: ["card"],
    favorite: true,
    age: 420,
    used: [22, 24 * 2],
  },
);
item(
  "CREDIT_CARD",
  "Mastercard Business",
  {
    cardholder: "ACME STORE LTD",
    number: "5555 5555 5555 4444",
    exp_month: "11",
    exp_year: "2026",
    cvv: "987",
    issuer: "BRAC Bank",
  },
  {
    project: "Acme Storefront",
    collection: "Finance",
    tags: ["card", "work"],
    age: 380,
    used: [9, 24 * 6],
  },
);
item(
  "CREDIT_CARD",
  "Amex Gold",
  {
    cardholder: "ADMIN MINIONS",
    number: "3782 822463 10005",
    exp_month: "03",
    exp_year: "2028",
    cvv: "4321",
    issuer: "American Express",
  },
  { project: "Personal", collection: "Finance", tags: ["card"], age: 210, used: [4, 24 * 12] },
);
item(
  "BANK_ACCOUNT",
  "City Bank savings",
  {
    bank: "City Bank",
    account_name: "Admin Minions",
    account_number: "2102 3345 6789 01",
    account_type: "Savings",
    routing: "225261732",
    branch: "Gulshan",
    url: "https://www.thecitybank.com",
    username: "admin.m",
    password: strong(),
  },
  { project: "Personal", collection: "Finance", tags: ["bank"], age: 900, used: [12, 24 * 5] },
);
item(
  "BANK_ACCOUNT",
  "BRAC Bank — Acme current",
  {
    bank: "BRAC Bank",
    account_name: "Acme Store Ltd",
    account_number: "1501 2034 5678 9001",
    account_type: "Business",
    branch: "Banani",
    url: "https://www.bracbank.com",
    username: "acme.finance",
    password: strong(),
  },
  {
    project: "Acme Storefront",
    collection: "Finance",
    tags: ["bank", "work"],
    age: 370,
    used: [7, 24 * 9],
  },
);
item(
  "BANK_ACCOUNT",
  "Wise USD account",
  {
    bank: "Wise",
    account_name: "Admin Minions",
    account_number: "8310 0072 3456",
    account_type: "Checking",
    iban: "GB33 BUKB 2020 1555 5555 55",
    routing: "026073150",
    url: "https://wise.com/login",
    username: "admin.personal@gmail.com",
    password: strong(),
  },
  {
    project: "Personal",
    collection: "Finance",
    tags: ["bank", "freelance"],
    age: 300,
    used: [10, 24 * 3],
  },
);
item(
  "PAYMENT_ACCOUNT",
  "Stripe dashboard — Acme",
  {
    provider: "Stripe",
    account_id: `acct_${alnum(16)}`,
    url: "https://dashboard.stripe.com",
    username: "finance@acme-store.com",
    password: strong(),
    environment: "Production",
  },
  {
    project: "Acme Storefront",
    collection: "Finance",
    tags: ["payments"],
    age: 200,
    used: [16, 24 * 1],
  },
);
item(
  "PAYMENT_ACCOUNT",
  "PayPal",
  {
    provider: "PayPal",
    url: "https://www.paypal.com/signin",
    username: "admin.personal@gmail.com",
    password: reusedPw,
  },
  {
    project: "Personal",
    collection: "Finance",
    tags: ["payments"],
    age: 1000,
    pwAge: 800,
    used: [3, 24 * 40],
  },
);
item(
  "PAYMENT_ACCOUNT",
  "bKash merchant",
  {
    provider: "bKash",
    account_id: "01711000000",
    url: "https://merchant.bkash.com",
    username: "01711000000",
    password: strong(),
  },
  {
    project: "Acme Storefront",
    collection: "Finance",
    tags: ["payments", "bd"],
    age: 150,
    used: [11, 24 * 2],
  },
);

// Other
item(
  "LICENSE",
  "JetBrains All Products Pack",
  {
    software: "JetBrains All Products",
    license_key: `${alnum(10).toUpperCase()}-${alnum(10).toUpperCase()}`,
    licensed_to: "Admin Minions",
    email: "admin@minions.local",
    purchase_date: daysFromNow(-320),
    expires_at: daysFromNow(45),
  },
  { collection: "Dev tools", tags: ["license"], age: 320, used: [1, 24 * 100] },
);
item(
  "LICENSE",
  "Adobe Creative Cloud",
  {
    software: "Adobe Creative Cloud",
    license_key: Array.from({ length: 6 }, () => hex(4).toUpperCase()).join("-"),
    licensed_to: "Acme Store Ltd",
    email: "admin@acme-store.com",
    expires_at: daysFromNow(-10),
  },
  {
    project: "Acme Storefront",
    collection: "Archive",
    tags: ["license", "design"],
    age: 400,
    used: null,
  },
);
item(
  "LICENSE",
  "Windows 11 Pro",
  {
    software: "Windows 11 Pro",
    license_key: Array.from({ length: 5 }, () => alnum(5).toUpperCase()).join("-"),
    licensed_to: "Admin",
  },
  { project: "Home Lab", collection: "Personal", tags: ["license"], age: 500, used: null },
);
item(
  "LICENSE",
  "Sublime Text",
  {
    software: "Sublime Text 4",
    license_key: `—— BEGIN LICENSE ——\nAdmin Minions\nSingle User License\n${hex(8).toUpperCase()} ${hex(8).toUpperCase()}\n—— END LICENSE ——`,
    licensed_to: "Admin Minions",
  },
  { collection: "Dev tools", tags: ["license"], age: 650, used: [1, 24 * 200] },
);
item(
  "SECURE_NOTE",
  "Home Wi-Fi",
  {
    content:
      "SSID: Minions-5G\nPassword: Purple-Banana-Orbit-77\nGuest: Minions-Guest / welcome2026",
  },
  {
    project: "Home Lab",
    collection: "Family",
    tags: ["network", "family"],
    favorite: true,
    age: 480,
    used: [30, 24 * 1],
  },
);
item(
  "SECURE_NOTE",
  "Passport details",
  { content: "Passport no: A01234567\nIssued: 2022-03-14 (Dhaka)\nExpires: 2032-03-13" },
  { project: "Personal", collection: "Personal", tags: ["identity"], age: 560, used: [2, 24 * 70] },
);
item(
  "SECURE_NOTE",
  "Office door & alarm codes",
  { content: "Main door: 4471#\nAlarm disarm: 2580\nServer room: ask facilities" },
  { project: "Northwind CRM", collection: "Work", tags: ["office"], age: 3, used: [1, 30] },
);

// Build and send each item exactly as the web client's encryptDraft does.
for (const it of items) {
  const def = core.getItemType(it.type);
  const fields = [];
  for (const [key, value] of Object.entries(it.values)) {
    const resolved = core.resolveField(it.type, key);
    if (!resolved) throw new Error(`${it.type}: unknown field ${key}`);
    const sensitive = resolved.def.sensitive;
    fields.push({
      key,
      sensitive,
      value: sensitive
        ? await core.encryptString(vaultKey, value, core.aad.field(it.id, key))
        : value,
    });
  }
  const signals = {};
  const pw = def.passwordField ? it.values[def.passwordField] : undefined;
  if (pw) {
    signals.passwordStrength = core.estimateStrength(pw).score;
    signals.passwordFingerprint = await core.secretFingerprint(vaultKey, pw);
  }
  if (it.type === "CREDIT_CARD") {
    const digits = it.values.number.replace(/\D/g, "");
    signals.cardLast4 = digits.slice(-4);
    const brand = core.cardBrand(digits);
    if (brand) signals.cardBrand = brand;
  }
  await api("POST", "/vault/items", {
    id: it.id,
    type: it.type,
    name: it.name,
    description: it.description ?? null,
    projectId: it.project ? P[it.project] : null,
    collectionId: it.collection ? C[it.collection] : null,
    favorite: it.favorite ?? false,
    tags: it.tags ?? [],
    usedByProjectIds: (it.usedBy ?? []).map((n) => P[n]),
    fields,
    signals,
  });
}
console.log(`Created ${items.length} items`);

const byName = (name) => items.find((i) => i.name === name).id;

// A few edits so items have version history.
for (const name of ["GitHub", "Acme Postgres (prod)", "Stripe live keys"]) {
  const it = items.find((i) => i.name === name);
  const key = core.getItemType(it.type).passwordField;
  const newValue = it.type === "API_KEY" ? `pk_live_${alnum(40)}` : strong();
  const detail = await api("GET", `/vault/items/${it.id}`);
  const fields = await Promise.all(
    detail.fields.map(async (f) =>
      f.key === key
        ? { ...f, value: await core.encryptString(vaultKey, newValue, core.aad.field(it.id, key)) }
        : f,
    ),
  );
  await api("PUT", `/vault/items/${it.id}`, {
    id: it.id,
    type: it.type,
    name: it.name,
    projectId: detail.project?.id ?? null,
    collectionId: detail.collection?.id ?? null,
    favorite: detail.favorite,
    tags: detail.tags,
    usedByProjectIds: detail.usedBy.map((p) => p.id),
    fields,
    signals: {
      passwordStrength: core.estimateStrength(newValue).score,
      passwordFingerprint: await core.secretFingerprint(vaultKey, newValue),
    },
    revision: detail.revision,
  });
}

// Relations
const relations = [
  ["GitHub recovery codes", "GitHub", "RECOVERY_FOR"],
  ["Google recovery codes", "Google Workspace", "RECOVERY_FOR"],
  ["AWS root account MFA", "AWS IAM — deploy user", "TWO_FACTOR_FOR"],
  ["Cloudflare 2FA", "Cloudflare API token", "TWO_FACTOR_FOR"],
  ["Acme Postgres (prod)", "acme-web-01 (prod)", "SERVICE_OF"],
  ["Acme Redis cache", "acme-web-01 (prod)", "SERVICE_OF"],
  ["Stripe webhook — orders", "Stripe live keys", "RELATED"],
  ["Stripe live keys", "Stripe dashboard — Acme", "RELATED"],
  ["GitHub Actions deploy key", "acme-web-01 (prod)", "USED_FOR"],
  ["Personal SSH key (ed25519)", "GitHub", "USED_FOR"],
  ["Google Workspace", "Slack — Acme", "USED_FOR"],
  ["Northwind MySQL (staging)", "northwind-staging", "SERVICE_OF"],
];
for (const [from, to, kind] of relations)
  await api("POST", "/relations", { fromItemId: byName(from), toItemId: byName(to), kind });

// ─── notes ──────────────────────────────────────────────────────────────────

const notes = [
  {
    title: "Acme deploy runbook",
    project: "Acme Storefront",
    collection: "Work",
    tags: ["runbook", "prod"],
    pinned: true,
    age: 120,
    html: `<h2>Deploying acme-storefront</h2><ol><li>Merge to <code>main</code>; CI builds the Docker image.</li><li>SSH to <strong>acme-web-01</strong> as <code>deploy</code>.</li><li><code>cd /srv/acme &amp;&amp; docker compose pull &amp;&amp; docker compose up -d</code></li><li>Run migrations: <code>docker compose exec web pnpm prisma migrate deploy</code></li><li>Check <a href="https://acme-store.com/health">/health</a> and Sentry.</li></ol><h3>Rollback</h3><p>Re-tag the previous image and <code>up -d</code> again. DB migrations are forward-only; restore from the nightly snapshot if needed.</p>`,
  },
  {
    title: "Northwind onboarding checklist",
    project: "Northwind CRM",
    collection: "Work",
    tags: ["onboarding"],
    favorite: true,
    age: 60,
    html: `<h2>New developer onboarding</h2><ul><li>Invite to GitHub org and Slack</li><li>Create staging DB user (read-only first week)</li><li>Share <em>northwind-api .env.staging</em> from the vault, never over chat</li><li>Walk through the CRM data model</li><li>Pair on first ticket</li></ul>`,
  },
  {
    title: "Incident 2026-09-14 — checkout outage",
    project: "Acme Storefront",
    collection: "Work",
    tags: ["incident", "prod"],
    age: 17,
    html: `<h2>Summary</h2><p>Checkout returned 500s for 23 minutes after the Stripe webhook secret was rotated without updating production env.</p><h3>Action items</h3><ul><li>Rotate secrets through the vault and update <em>.env.production</em> in the same change</li><li>Alert on webhook signature failures</li></ul>`,
  },
  {
    title: "Recipe Box — feature ideas",
    project: "Recipe Box",
    collection: "Personal",
    tags: ["ideas"],
    age: 40,
    html: `<ul><li>Pantry mode: suggest recipes from what's in the fridge</li><li>Bangla recipe import from YouTube descriptions</li><li>Shopping list sync with family</li><li>Nutrition estimate per serving</li></ul>`,
  },
  {
    title: "Home network map",
    project: "Home Lab",
    collection: "Family",
    tags: ["network"],
    pinned: true,
    age: 200,
    html: `<table><tr><th>Device</th><th>IP</th></tr><tr><td>Router</td><td>192.168.0.1</td></tr><tr><td>NAS</td><td>192.168.0.20</td></tr><tr><td>Home Assistant Pi</td><td>192.168.0.50</td></tr><tr><td>Printer</td><td>192.168.0.80</td></tr></table>`,
  },
  {
    title: "Minions roadmap Q4",
    project: "Minions Platform",
    collection: "Work",
    tags: ["planning"],
    favorite: true,
    age: 5,
    html: `<h2>Q4 2026</h2><ol><li>Passkey sign-in</li><li>Shared vaults for families</li><li>Mobile app (Tauri mobile)</li><li>Breach monitoring for saved emails</li></ol>`,
  },
  {
    title: "Tax documents 2025",
    project: "Personal",
    collection: "Finance",
    tags: ["tax"],
    age: 150,
    html: `<p>Return filed 2025-11-28. TIN certificate and acknowledgement slip are in Google Drive / Taxes / 2025.</p><p>Freelance income via Wise and Payoneer; keep FX statements.</p>`,
  },
  {
    title: "Client meeting notes — Northwind",
    project: "Northwind CRM",
    collection: "Work",
    tags: ["meetings"],
    age: 1,
    html: `<p><strong>Attendees:</strong> Sarah (PM), Rahim (ops), me</p><ul><li>Bulk import of legacy contacts by end of month</li><li>SSO with their Google Workspace</li><li>Staging access for their QA team</li></ul>`,
  },
];
for (const n of notes) {
  n.id = randomUUID();
  await api("POST", "/notes", {
    id: n.id,
    title: n.title,
    contentEnc: await core.encryptString(vaultKey, n.html, core.aad.note(n.id)),
    projectId: P[n.project] ?? null,
    collectionId: C[n.collection] ?? null,
    tags: n.tags,
    pinned: n.pinned ?? false,
    favorite: n.favorite ?? false,
  });
}
console.log(`Created ${notes.length} notes`);

// One item in the trash.
const trashed = items.find((i) => i.name === "Dropbox");
await api("DELETE", `/vault/items/${trashed.id}`);

// ─── history: timestamps, usage, devices, activity ──────────────────────────

await db.query("BEGIN");

for (const it of items) {
  const created = ago(it.age * DAY + rand(0, 20) * HOUR);
  const pwChanged = it.pwAge ? ago(it.pwAge * DAY) : created;
  const [count, lastHours] = it.used ?? [0, null];
  const lastAccessed = lastHours === null ? null : ago(lastHours * HOUR + rand(0, 50) * 60_000);
  const updated = new Date(
    Math.max(
      created.getTime(),
      Math.min(now - rand(1, 30) * HOUR, created.getTime() + rand(0, it.age) * DAY),
    ),
  );
  await db.query(
    `UPDATE vault_items SET "createdAt" = $2, "updatedAt" = $3,
       "passwordUpdatedAt" = CASE WHEN "passwordUpdatedAt" IS NULL THEN NULL ELSE $4::timestamp END,
       "lastRotatedAt" = CASE WHEN "lastRotatedAt" IS NULL THEN NULL ELSE LEAST("lastRotatedAt", $4::timestamp) END,
       "lastAccessedAt" = $5, "accessCount" = $6
     WHERE id = $1`,
    [it.id, created, updated, pwChanged, lastAccessed, count],
  );
  it.created = created;
  it.lastAccessed = lastAccessed;
  it.count = count;
}
// The versions made above happened "recently", not just now.
await db.query(
  `UPDATE vault_item_versions SET "createdAt" = now() - interval '9 days' WHERE "itemId" = ANY($1::uuid[])`,
  [items.map((i) => i.id)],
);
await db.query(`UPDATE vault_items SET "deletedAt" = now() - interval '4 days' WHERE id = $1`, [
  trashed.id,
]);

for (const n of notes) {
  const created = ago(n.age * DAY + rand(0, 10) * HOUR);
  const updated = ago(Math.min(n.age, rand(0, 6)) * DAY + rand(1, 10) * HOUR);
  await db.query(`UPDATE notes SET "createdAt" = $2, "updatedAt" = $3 WHERE id = $1`, [
    n.id,
    created,
    updated,
  ]);
}
const backdate = (table, days) =>
  db.query(
    `UPDATE ${table} SET "createdAt" = now() - make_interval(days => $2) WHERE "vaultId" = $1`,
    [vaultId, days],
  );
await backdate("projects", 300);
await backdate("collections", 300);
await backdate("tags", 300);

// Devices other than the browser the user is on.
const demoDevices = [
  {
    name: "iPhone 16 · Safari",
    kind: "WEB",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile Safari/604.1",
    ip: "103.48.16.22",
    lastActive: 3 * HOUR,
    created: 120 * DAY,
  },
  {
    name: "MacBook Air · Chrome extension",
    kind: "EXTENSION",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0 Safari/537.36",
    ip: "103.48.16.22",
    lastActive: 26 * HOUR,
    created: 200 * DAY,
  },
  {
    name: "Minions Desktop · Windows",
    kind: "DESKTOP",
    ua: "Minions Desktop/0.1.0 (Windows NT 10.0)",
    ip: "119.30.45.8",
    lastActive: 2 * DAY,
    created: 90 * DAY,
  },
  {
    name: "Office PC · Edge",
    kind: "WEB",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140.0",
    ip: "202.4.110.17",
    lastActive: 9 * DAY,
    created: 160 * DAY,
  },
  {
    name: "Old ThinkPad · Firefox",
    kind: "WEB",
    ua: "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Firefox/128.0",
    ip: "45.120.8.200",
    lastActive: 140 * DAY,
    created: 600 * DAY,
    revoked: 120 * DAY,
  },
];
for (const d of demoDevices) {
  d.id = randomUUID();
  await db.query(
    `INSERT INTO devices (id, "userId", "clientDeviceId", name, kind, "userAgent", "lastIp", "lastActiveAt", "revokedAt", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      d.id,
      userId,
      randomUUID(),
      d.name,
      d.kind,
      d.ua,
      d.ip,
      ago(d.lastActive),
      d.revoked ? ago(d.revoked) : null,
      ago(d.created),
    ],
  );
  if (!d.revoked) {
    d.sessionId = randomUUID();
    // A random hash: no token exists that could ever match it.
    await db.query(
      `INSERT INTO sessions (id, "userId", "deviceId", "tokenHash", state, ip, "userAgent", "createdAt", "lastActiveAt", "expiresAt")
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7, $8, now() + interval '20 days')`,
      [
        d.sessionId,
        userId,
        d.id,
        createHash("sha256").update(nodeRandomBytes(32)).digest("hex"),
        d.ip,
        d.ua,
        ago(d.lastActive + 2 * DAY),
        ago(d.lastActive),
      ],
    );
  }
}
const activeDevices = demoDevices.filter((d) => !d.revoked);

// Activity: what weeks of real use would have logged.
const activity = [];
const log = (action, at, device, it, metadata) =>
  activity.push({ action, at, device, it, metadata });

for (const it of items) log("item.created", it.created, pick(activeDevices), it);
for (const it of items.filter((i) => i.count > 0)) {
  const events = Math.min(it.count, 8);
  for (let k = 0; k < events; k++) {
    const at =
      k === 0
        ? it.lastAccessed
        : ago(rand(it.lastAccessed ? now - it.lastAccessed.getTime() : 0, 30 * DAY));
    const action =
      it.type === "TOTP" || (it.values.totp && Math.random() < 0.4)
        ? "item.totp_generated"
        : it.type === "LOGIN" && Math.random() < 0.4
          ? "item.autofilled"
          : pick(["item.copied", "item.copied", "item.viewed", "item.revealed"]);
    log(
      action,
      at,
      pick(activeDevices),
      it,
      action === "item.copied"
        ? { field: core.getItemType(it.type).passwordField ?? "username" }
        : undefined,
    );
  }
}
for (const name of ["GitHub", "Acme Postgres (prod)", "Stripe live keys"])
  log(
    "item.updated",
    ago(9 * DAY),
    activeDevices[0],
    items.find((i) => i.name === name),
  );
log("item.deleted", ago(4 * DAY), activeDevices[1], trashed);
for (const n of notes)
  log("note.created", ago(n.age * DAY), pick(activeDevices), {
    id: n.id,
    name: n.title,
    type: "NOTE",
  });
for (let d = 0; d < 30; d++) {
  const dev = pick(activeDevices);
  log("auth.login", ago(d * DAY + rand(1, 12) * HOUR), dev);
  log("vault.unlocked", ago(d * DAY + rand(0, 1) * HOUR), dev);
  if (Math.random() < 0.5) log("vault.locked", ago(d * DAY + rand(0, 1) * HOUR), dev);
}
log("auth.login_failed", ago(6 * DAY + 3 * HOUR), null, null, { reason: "bad_credentials" });
log("vault.unlock_failed", ago(11 * DAY), activeDevices[0]);
log("vault.exported", ago(33 * DAY), activeDevices[2]);
log("import.completed", ago(250 * DAY), activeDevices[3], null, { source: "chrome", imported: 18 });
for (const d of demoDevices) log("device.added", ago(d.created), d);
log("device.revoked", ago(120 * DAY), activeDevices[0], null, { device: "Old ThinkPad · Firefox" });

for (const a of activity) {
  await db.query(
    `INSERT INTO activity_logs (id, "userId", action, "itemId", "itemName", "itemType", "deviceId", "sessionId", ip, "userAgent", metadata, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      randomUUID(),
      userId,
      a.action,
      a.it?.id ?? null,
      a.it?.name ?? null,
      a.it?.type ?? null,
      a.device?.id ?? null,
      a.device?.sessionId ?? null,
      a.device?.ip ?? "103.48.16.22",
      a.device?.ua ?? null,
      a.metadata ? JSON.stringify(a.metadata) : null,
      a.at,
    ],
  );
}

const securityEvents = [
  ["new_device", "medium", demoDevices[0], 120 * DAY],
  ["new_device", "medium", demoDevices[2], 90 * DAY],
  ["login_failed", "low", null, 6 * DAY],
  ["unlock_failed", "low", demoDevices[0], 11 * DAY],
  ["device_revoked", "medium", demoDevices[4], 120 * DAY],
  ["recovery_codes_regenerated", "medium", demoDevices[1], 45 * DAY],
];
for (const [type, severity, d, when] of securityEvents)
  await db.query(
    `INSERT INTO security_events (id, "userId", type, severity, "deviceId", ip, "userAgent", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      userId,
      type,
      severity,
      d?.id ?? null,
      d?.ip ?? "45.120.8.200",
      d?.ua ?? null,
      ago(when),
    ],
  );

// Leave no trace of this script: its own activity, session and device.
await cleanupSeedDevice();
// "Since your last visit" counts from here.
await db.query(`UPDATE users SET "previousVisitAt" = now() - interval '4 days' WHERE id = $1`, [
  userId,
]);
await db.query(`UPDATE security_snapshots SET "dirtyAt" = now() WHERE "vaultId" = $1`, [vaultId]);
await db.query("COMMIT");
await db.end();

console.log(
  `Added ${activity.length} activity entries, ${demoDevices.length} devices. Done — reload the app.`,
);

async function cleanupSeedDevice() {
  // By name too, so a run that failed halfway leaves nothing behind either.
  const dev = await db.query(
    `SELECT id FROM devices WHERE "userId" = $1 AND ("clientDeviceId" = $2 OR name = 'Demo seed')`,
    [userId, seedDeviceId],
  );
  const ids = dev.rows.map((r) => r.id);
  if (!ids.length) return;
  await db.query(`DELETE FROM activity_logs WHERE "userId" = $1 AND "deviceId" = ANY($2::uuid[])`, [
    userId,
    ids,
  ]);
  await db.query(
    `DELETE FROM security_events WHERE "userId" = $1 AND "deviceId" = ANY($2::uuid[])`,
    [userId, ids],
  );
  await db.query(`DELETE FROM sessions WHERE "deviceId" = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [ids]);
}
