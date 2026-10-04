// Scale benchmark: a vault with N items, timed through the real API.
//   node tests/bench/scale.mjs [count]   (API running, DATABASE_URL in apps/api/.env)
// Rows are inserted directly for speed. Secret fields hold random envelopes:
// the server never sees a plaintext value either way.
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
require("dotenv").config({ path: new URL("../../apps/api/.env", import.meta.url) });
const { Client } = require("pg");
const core = await import("../../packages/core/dist/index.js");

const N = Number(process.argv[2] ?? 100_000);
const API = process.env.API_URL ?? "http://localhost:4600";
const password = "Bench-Password-123456";
const email = `bench-${Date.now()}@example.com`;

// Account through the API, so the vault is real.
const userId = randomUUID();
const vaultId = randomUUID();
const keys = await core.createAccountKeys(password, userId, vaultId, {
  ...core.DEFAULT_KDF,
  memory: 19456,
  iterations: 2,
  salt: core.toBase64(core.randomBytes(16)),
});
const reg = await fetch(`${API}/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-minions-client": "extension" },
  body: JSON.stringify({
    email,
    name: "Bench",
    userId,
    vaultId,
    authKey: keys.authKey,
    kdf: keys.kdf,
    protectedUserKey: keys.protectedUserKey,
    protectedVaultKey: keys.protectedVaultKey,
    device: { clientDeviceId: randomUUID(), name: "bench", kind: "extension" },
  }),
});
const { token } = await reg.json();
const auth = { authorization: `Bearer ${token}`, "x-minions-client": "extension" };

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const envelope = () =>
  `v1.${randomBytes(12).toString("base64")}.${randomBytes(40).toString("base64")}`;
const hosts = [
  "github.com",
  "google.com",
  "cloudflare.com",
  "aws.amazon.com",
  "notion.so",
  "stripe.com",
  "example.com",
  "slack.com",
];
const sharedFingerprints = Array.from({ length: 50 }, () => randomBytes(32).toString("hex"));
const now = Date.now();

console.log(`Inserting ${N} items…`);
const t = Date.now();
for (let start = 0; start < N; start += 2000) {
  const items = [];
  const fields = [];
  for (let i = start; i < Math.min(N, start + 2000); i++) {
    const id = randomUUID();
    const host = i % 3 === 0 ? hosts[i % hosts.length] : `site${i}.example.org`;
    const username = `user${i % 5000}@example.com`;
    const strength = i % 10 === 0 ? 1 : 4;
    const fp = i % 20 === 0 ? sharedFingerprints[i % 50] : randomBytes(32).toString("hex");
    const created = new Date(now - (i % 400) * 86_400_000);
    items.push([
      id,
      vaultId,
      "LOGIN",
      `Site ${i}`,
      host,
      username,
      strength,
      fp,
      created,
      i % 7 === 0 ? null : created,
      `site ${i} ${host} ${username}`,
    ]);
    fields.push(
      [randomUUID(), id, "url", false, `https://${host}`, 0],
      [randomUUID(), id, "username", false, username, 1],
      [randomUUID(), id, "password", true, envelope(), 2],
    );
  }
  const ph = (rows, width) =>
    rows
      .map(
        (_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(",")})`,
      )
      .join(",");
  await db.query(
    `INSERT INTO vault_items (id,"vaultId",type,name,host,username,"passwordStrength","passwordFingerprint","createdAt","lastAccessedAt","searchText","passwordUpdatedAt","updatedAt") SELECT v.*, v.c9, now() FROM (VALUES ${ph(items, 11)}) AS v(c1,c2,c3,c4,c5,c6,c7,c8,c9,c10,c11)`.replace(
      "SELECT v.*, v.c9, now()",
      "SELECT c1::uuid,c2::uuid,c3,c4,c5,c6,c7::int,c8,c9::timestamp,c10::timestamp,c11,c9::timestamp,now()",
    ),
    items.flat(),
  );
  await db.query(
    `INSERT INTO vault_item_fields (id,"itemId",key,sensitive,value,position) SELECT c1::uuid,c2::uuid,c3,c4::boolean,c5,c6::int FROM (VALUES ${ph(fields, 6)}) AS v(c1,c2,c3,c4,c5,c6)`,
    fields.flat(),
  );
}
console.log(`  inserted in ${((Date.now() - t) / 1000).toFixed(1)}s`);

// The API needs an unlocked session for vault routes.
const { authKey } = await core.deriveMasterKeys(password, keys.kdf);
await fetch(`${API}/vault/unlock`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ authKey }),
});

async function timed(label, path) {
  const s = performance.now();
  const res = await fetch(`${API}${path}`, { headers: auth });
  const body = await res.text();
  const ms = performance.now() - s;
  console.log(
    `${label.padEnd(36)} ${res.status}  ${ms.toFixed(0).padStart(6)} ms  ${(body.length / 1024).toFixed(0)} KB`,
  );
  return JSON.parse(body);
}

const first = await timed("Security Center (first ever, builds)", "/security/findings");
await timed("Security Center (warm)", "/security/findings");
await timed(
  "Security Center, 100 more unused",
  "/security/findings/page?type=unused&offset=50&limit=100",
);
// A change marks the snapshot dirty; the next read serves the previous one
// immediately while the rebuild runs in the background.
const one = await fetch(`${API}/vault/items?limit=1`, { headers: auth }).then((r) => r.json());
await fetch(`${API}/vault/items/${one.items[0].id}`, {
  method: "PATCH",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ favorite: true }),
});
const afterChange = await timed("Security Center (right after a change)", "/security/findings");
console.log(`  refreshing in background: ${afterChange.refreshing}`);
await timed("Dashboard", "/dashboard");
await timed("Vault list, first page", "/vault/items?limit=60");
await timed("Search 'site 4242'", "/vault/items?q=site%204242&limit=60");
await timed("Search by host 'cloudflare'", "/vault/items?q=cloudflare&limit=60");
await timed("Extension match github.com", "/vault/items/match?host=github.com");
console.log("\nScore", first.score, "counts", JSON.stringify(first.counts));

await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
await db.query(`DELETE FROM security_finding_records WHERE "vaultId" = $1`, [vaultId]);
await db.query(`DELETE FROM security_snapshots WHERE "vaultId" = $1`, [vaultId]);
await db.end();
console.log("Cleaned up the benchmark account.");
