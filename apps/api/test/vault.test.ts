import { randomUUID } from "node:crypto";
import { aad, decryptString, encryptString, type VaultItemDetail } from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import type { PrismaService } from "../src/common/prisma.service";
import { buildItem, createApp, login, registerUser, resetDb, type TestUser } from "./helpers";

let app: INestApplication;
let prisma: PrismaService;
let user: TestUser;

beforeAll(async () => {
  ({ app, prisma } = await createApp());
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb(prisma);
  user = await registerUser(app);
});

async function decryptField(u: TestUser, item: VaultItemDetail, key: string) {
  const f = item.fields.find((x) => x.key === key)!;
  return f.sensitive ? decryptString(u.vaultKey, f.value, aad.field(item.id, key)) : f.value;
}

/** Every text-ish column in every table, for "is this plaintext anywhere?" checks. */
async function databaseDump(): Promise<string> {
  const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'",
  );
  let out = "";
  for (const { table_name } of tables) {
    const rows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${table_name}"`);
    out += JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  return out;
}

const SECRETS = {
  password: "Pl@intext-Should-Never-Appear-1",
  apiKey: "sk-proj-NEVERINDATABASEabcdefghijklmnop",
  card: "4111111111111111",
  totp: "JBSWY3DPEHPK3PXPNEVERSTORED",
  bankPw: "bank-password-NEVER-STORED",
  sshKey:
    "-----BEGIN OPENSSH PRIVATE KEY-----\nNEVERSTOREDKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----",
  dbPw: "db-password-NEVER-STORED",
  noteBody: "<p>Secret note body NEVER STORED</p>",
};

describe("vault items: CRUD", () => {
  it("creates, reads, updates and deletes a login", async () => {
    const body = await buildItem(user, "LOGIN", "GitHub", {
      url: "https://github.com/login",
      username: "octo",
      password: SECRETS.password,
    });
    const created = await user.agent.post("/vault/items").send(body).expect(201);
    expect(created.body).toMatchObject({
      name: "GitHub",
      host: "github.com",
      username: "octo",
      revision: 1,
    });

    const got = await user.agent.get(`/vault/items/${body.id}`).expect(200);
    expect(await decryptField(user, got.body, "password")).toBe(SECRETS.password);

    const updated = await buildItem(
      user,
      "LOGIN",
      "GitHub (work)",
      { url: "https://github.com/login", username: "octo", password: "N3w-Passw0rd-Value!" },
      { id: body.id, revision: 1 },
    );
    const put = await user.agent.put(`/vault/items/${body.id}`).send(updated).expect(200);
    expect(put.body.revision).toBe(2);

    const stale = await user.agent
      .put(`/vault/items/${body.id}`)
      .send({ ...updated, revision: 1 })
      .expect(409);
    expect(stale.body.code).toBe("REVISION_CONFLICT");

    await user.agent.delete(`/vault/items/${body.id}`).expect(204);
    const list = await user.agent.get("/vault/items").expect(200);
    expect(list.body.items).toHaveLength(0);
    const trash = await user.agent.get("/vault/items?trash=true").expect(200);
    expect(trash.body.items).toHaveLength(1);
    await user.agent.post(`/vault/items/${body.id}/restore`).expect(204);
    await user.agent.delete(`/vault/items/${body.id}/purge`).expect(400);
  });

  it("keeps encrypted history of previous values", async () => {
    const body = await buildItem(user, "LOGIN", "Google", {
      username: "me@gmail.com",
      password: "first-password-123",
    });
    await user.agent.post("/vault/items").send(body).expect(201);
    const next = await buildItem(
      user,
      "LOGIN",
      "Google",
      { username: "me@gmail.com", password: "second-password-456" },
      { id: body.id },
    );
    await user.agent.put(`/vault/items/${body.id}`).send(next).expect(200);
    const versions = await user.agent.get(`/vault/items/${body.id}/versions`).expect(200);
    expect(versions.body).toHaveLength(1);
    expect(versions.body[0].changedKeys).toEqual(["password"]);
    const old = versions.body[0].fields[0];
    expect(old.value).not.toContain("first-password");
    expect(await decryptString(user.vaultKey, old.value, aad.field(body.id, "password"))).toBe(
      "first-password-123",
    );
  });

  it("an unchanged envelope is not a change", async () => {
    const body = await buildItem(user, "API_KEY", "OpenAI", {
      provider: "OpenAI",
      api_key: SECRETS.apiKey,
      environment: "Production",
    });
    await user.agent.post("/vault/items").send(body).expect(201);
    await user.agent
      .put(`/vault/items/${body.id}`)
      .send({ ...body, name: "OpenAI prod" })
      .expect(200);
    const versions = await user.agent.get(`/vault/items/${body.id}/versions`).expect(200);
    expect(versions.body).toHaveLength(0);
  });
});

describe("encryption boundary", () => {
  it("refuses plaintext in a sensitive field, even if the client says it is not sensitive", async () => {
    const id = randomUUID();
    const res = await user.agent
      .post("/vault/items")
      .send({
        id,
        type: "LOGIN",
        name: "Bad",
        fields: [{ key: "password", value: "plaintext!", sensitive: false }],
      })
      .expect(400);
    expect(res.body.code).toBe("PLAINTEXT_SECRET");
    expect(JSON.stringify(res.body)).not.toContain("plaintext!");
  });

  it("refuses unknown fields and types", async () => {
    await user.agent
      .post("/vault/items")
      .send({ id: randomUUID(), type: "NOPE", name: "x", fields: [] })
      .expect(400);
    await user.agent
      .post("/vault/items")
      .send({
        id: randomUUID(),
        type: "LOGIN",
        name: "x",
        fields: [{ key: "evil", value: "v", sensitive: false }],
      })
      .expect(400);
  });

  it("stores no plaintext secret anywhere in PostgreSQL", async () => {
    const items = [
      await buildItem(user, "LOGIN", "Site", {
        username: "me",
        password: SECRETS.password,
        totp: SECRETS.totp,
      }),
      await buildItem(user, "API_KEY", "OpenAI", { provider: "OpenAI", api_key: SECRETS.apiKey }),
      await buildItem(
        user,
        "CREDIT_CARD",
        "Visa",
        { cardholder: "Me", number: SECRETS.card, cvv: "927", exp_month: "12", exp_year: "2030" },
        { signals: { cardLast4: "1111", cardBrand: "Visa" } },
      ),
      await buildItem(user, "BANK_ACCOUNT", "Bank", {
        bank: "Big Bank",
        account_number: "000123456789",
        password: SECRETS.bankPw,
      }),
      await buildItem(user, "SERVER", "VPS", {
        host: "10.0.0.1",
        username: "root",
        private_key: SECRETS.sshKey,
      }),
      await buildItem(user, "DATABASE", "DB", {
        host: "db.local",
        username: "app",
        password: SECRETS.dbPw,
        connection_string: `postgres://app:${SECRETS.dbPw}@db.local/app`,
      }),
    ];
    for (const item of items) await user.agent.post("/vault/items").send(item).expect(201);
    const noteId = randomUUID();
    await user.agent
      .post("/notes")
      .send({
        id: noteId,
        title: "Plans",
        contentEnc: await encryptString(user.vaultKey, SECRETS.noteBody, aad.note(noteId)),
      })
      .expect(201);
    // Generate activity too: views and copies.
    for (const item of items) {
      await user.agent.get(`/vault/items/${item.id}`).expect(200);
      await user.agent
        .post(`/vault/items/${item.id}/usage`)
        .send({ action: "item.copied", field: "password" })
        .expect(204);
    }

    const dump = await databaseDump();
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(dump.includes(secret), `${name} found in database`).toBe(false);
    }
    expect(dump).not.toContain("000123456789");
    // A 3-digit CVV collides with random base64 and timestamps; check the field itself.
    const cvv = await prisma.vaultItemField.findFirstOrThrow({ where: { key: "cvv" } });
    expect(cvv.sensitive).toBe(true);
    expect(cvv.value).toMatch(/^v1./);
    expect(dump).not.toContain(user.password);
    expect(dump).not.toContain(user.authKey);
  });

  it("server-derived metadata comes only from non-sensitive fields", async () => {
    const card = await buildItem(
      user,
      "CREDIT_CARD",
      "Visa",
      { number: SECRETS.card, cvv: "927" },
      { signals: { cardLast4: "1111", cardBrand: "Visa" } },
    );
    const res = await user.agent.post("/vault/items").send(card).expect(201);
    expect(res.body.subtitle).toBe("Visa •••• 1111");
    expect(res.body.cardLast4).toBe("1111");
    expect(JSON.stringify(res.body)).not.toContain(SECRETS.card);
  });
});

describe("vault lock", () => {
  it("locks, refuses vault access while locked, and unlocks only with the master password", async () => {
    const body = await buildItem(user, "LOGIN", "Site", {
      username: "me",
      password: "pw-123456789",
    });
    await user.agent.post("/vault/items").send(body).expect(201);
    await user.agent.post("/vault/lock").expect(204);

    const locked = await user.agent.get(`/vault/items/${body.id}`).expect(403);
    expect(locked.body.code).toBe("VAULT_LOCKED");
    await user.agent.get("/vault/items").expect(403);
    await user.agent.get("/notes").expect(403);
    await user.agent.get("/auth/me").expect(200); // still signed in

    const bad = await user.agent
      .post("/vault/unlock")
      .send({ authKey: Buffer.alloc(32, 1).toString("base64") })
      .expect(403);
    expect(bad.body.code).toBe("BAD_MASTER_PASSWORD");
    const ok = await user.agent.post("/vault/unlock").send({ authKey: user.authKey }).expect(200);
    expect(ok.body.keys.protectedVaultKey).toBeTruthy();
    await user.agent.get(`/vault/items/${body.id}`).expect(200);
  });

  it("locks by itself when the unlock window passes", async () => {
    await prisma.session.updateMany({
      where: { userId: user.userId },
      data: { vaultUnlockedUntil: new Date(Date.now() - 1000) },
    });
    await user.agent.get("/vault/items").expect(403);
  });

  it("exports an encrypted backup with no plaintext", async () => {
    const body = await buildItem(user, "LOGIN", "Site", {
      username: "me",
      password: SECRETS.password,
    });
    await user.agent.post("/vault/items").send(body).expect(201);
    const backup = await user.agent.get("/vault/export").expect(200);
    expect(backup.body.format).toBe("minions-encrypted-backup");
    expect(JSON.stringify(backup.body)).not.toContain(SECRETS.password);
    expect(
      backup.body.items[0].fields.find((f: { key: string }) => f.key === "password").value,
    ).toMatch(/^v1\./);
  });
});

describe("credential types round-trip", () => {
  const cases: [string, Record<string, string>][] = [
    [
      "LOGIN",
      {
        url: "https://accounts.google.com",
        username: "me",
        email: "me@gmail.com",
        password: "pw",
        totp: "JBSWY3DPEHPK3PXP",
        backup_codes: "1111 2222",
      },
    ],
    [
      "API_KEY",
      {
        provider: "OpenAI",
        api_key: "sk-test",
        api_secret: "sec",
        environment: "Production",
        expires_at: "2030-01-01",
      },
    ],
    ["TOTP", { issuer: "GitHub", account: "octo", totp: "JBSWY3DPEHPK3PXP" }],
    [
      "SSH_KEY",
      { private_key: "-----BEGIN KEY-----x", public_key: "ssh-ed25519 AAAA", passphrase: "pp" },
    ],
    ["SERVER", { host: "1.2.3.4", port: "22", username: "root", password: "pw", private_key: "k" }],
    [
      "DATABASE",
      {
        engine: "PostgreSQL",
        host: "db",
        port: "5432",
        database: "app",
        username: "u",
        password: "p",
        connection_string: "postgres://u:p@db/app",
      },
    ],
    ["CLOUD", { provider: "Cloudflare", account_id: "abc", secret_key: "token" }],
    [
      "ENVIRONMENT",
      {
        environment: "Production",
        "var.DATABASE_URL": "postgres://x",
        "var.OPENAI_API_KEY": "sk-x",
      },
    ],
    [
      "WEBHOOK",
      { provider: "Stripe", endpoint: "https://api.example.com/hooks", secret: "whsec_x" },
    ],
    [
      "CREDIT_CARD",
      {
        cardholder: "Me",
        number: "4111111111111111",
        exp_month: "01",
        exp_year: "2031",
        cvv: "123",
      },
    ],
    ["BANK_ACCOUNT", { bank: "Bank", account_number: "123", password: "pw", username: "user" }],
    [
      "PAYMENT_ACCOUNT",
      {
        provider: "Stripe",
        username: "me",
        password: "pw",
        api_key: "sk_live_x",
        environment: "Production",
      },
    ],
    ["LICENSE", { software: "JetBrains", license_key: "ABC-DEF", expires_at: "2027-01-01" }],
    ["SECURE_NOTE", { content: "hello" }],
    ["RECOVERY_CODE", { service: "Google", codes: "1 2 3" }],
    ["DOMAIN", { domain: "example.com", registrar: "Porkbun", password: "pw" }],
  ];
  it.each(cases)("%s", async (type, values) => {
    const body = await buildItem(user, type, `${type} item`, values);
    await user.agent.post("/vault/items").send(body).expect(201);
    const got = (await user.agent.get(`/vault/items/${body.id}`).expect(200))
      .body as VaultItemDetail;
    for (const [key, value] of Object.entries(values))
      expect(await decryptField(user, got, key)).toBe(value);
  });
});

describe("authorization: one user can never reach another's vault", () => {
  it("blocks reads, writes, deletes, relations, projects and notes", async () => {
    const alice = user;
    const bob = await registerUser(app);
    const item = await buildItem(alice, "LOGIN", "Alice's bank", {
      username: "alice",
      password: "alice-secret-1",
    });
    await alice.agent.post("/vault/items").send(item).expect(201);
    const project = (
      await alice.agent.post("/projects").send({ name: "Alice project" }).expect(201)
    ).body;
    const noteId = randomUUID();
    await alice.agent.post("/notes").send({ id: noteId, title: "Alice note" }).expect(201);

    await bob.agent.get(`/vault/items/${item.id}`).expect(404);
    await bob.agent.get(`/vault/items/${item.id}/versions`).expect(404);
    const steal = await buildItem(bob, "LOGIN", "pwned", { username: "bob" }, { id: item.id });
    await bob.agent.put(`/vault/items/${item.id}`).send(steal).expect(404);
    await bob.agent.patch(`/vault/items/${item.id}`).send({ favorite: true }).expect(404);
    await bob.agent.delete(`/vault/items/${item.id}`).expect(404);
    await bob.agent
      .post(`/vault/items/${item.id}/usage`)
      .send({ action: "item.copied" })
      .expect(404);
    // Bob cannot create an item with Alice's id either.
    await bob.agent.post("/vault/items").send(steal).expect(409);

    const bobItem = await buildItem(bob, "LOGIN", "Bob's", { username: "bob" });
    await bob.agent.post("/vault/items").send(bobItem).expect(201);
    await bob.agent
      .post("/relations")
      .send({ fromItemId: bobItem.id, toItemId: item.id, kind: "RELATED" })
      .expect(404);
    await bob.agent
      .post(`/vault/items/${bobItem.id}/merge`)
      .send({ sourceIds: [item.id] })
      .expect(404);
    await bob.agent
      .post("/vault/items")
      .send(await buildItem(bob, "LOGIN", "x", { username: "b" }, { projectId: project.id }))
      .expect(400);

    await bob.agent.get(`/projects/${project.id}`).expect(404);
    await bob.agent.patch(`/projects/${project.id}`).send({ name: "mine" }).expect(404);
    await bob.agent.get(`/notes/${noteId}`).expect(404);
    await bob.agent.delete(`/notes/${noteId}`).expect(404);

    const list = await bob.agent.get("/vault/items?q=alice").expect(200);
    expect(list.body.items).toHaveLength(0);
    const match = await bob.agent.get("/vault/items/match?host=example.com").expect(200);
    expect(match.body).toHaveLength(0);

    // Alice's data is untouched.
    const still = await alice.agent.get(`/vault/items/${item.id}`).expect(200);
    expect(still.body.name).toBe("Alice's bank");
  });

  it("a revoked session cannot be reused", async () => {
    const other = await login(app, user, { clientDeviceId: "revoke-me-00001" });
    await user.agent.post("/sessions/revoke-all").send({}).expect(200);
    await other.agent.get("/vault/items").expect(401);
  });
});

describe("search, filters and matching", () => {
  it("searches safe metadata, project names and tags but not secrets", async () => {
    const project = (await user.agent.post("/projects").send({ name: "ClipMesh" }).expect(201))
      .body;
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(
          user,
          "API_KEY",
          "OpenAI production",
          { provider: "OpenAI", api_key: "sk-findme-not" },
          { projectId: project.id, tags: ["ai", "production"] },
        ),
      )
      .expect(201);
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(user, "LOGIN", "Google", {
          url: "https://accounts.google.com",
          username: "me@gmail.com",
          password: "x",
        }),
      )
      .expect(201);

    expect((await user.agent.get("/vault/items?q=openai").expect(200)).body.items).toHaveLength(1);
    expect((await user.agent.get("/vault/items?q=clipmesh").expect(200)).body.items).toHaveLength(
      1,
    );
    expect((await user.agent.get("/vault/items?tag=ai").expect(200)).body.items).toHaveLength(1);
    expect((await user.agent.get("/vault/items?q=gmail").expect(200)).body.items).toHaveLength(1);
    expect((await user.agent.get("/vault/items?q=findme").expect(200)).body.items).toHaveLength(0);
    expect(
      (await user.agent.get("/vault/items?category=secret").expect(200)).body.items,
    ).toHaveLength(1);
    expect(
      (await user.agent.get(`/vault/items?projectId=${project.id}`).expect(200)).body.items,
    ).toHaveLength(1);

    const match = await user.agent.get("/vault/items/match?host=mail.google.com").expect(200);
    expect(match.body.map((i: { name: string }) => i.name)).toEqual(["Google"]);
  });

  it("paginates with a cursor", async () => {
    for (let i = 0; i < 5; i++)
      await user.agent
        .post("/vault/items")
        .send(await buildItem(user, "SECURE_NOTE", `Note ${i}`, { content: "x" }))
        .expect(201);
    const first = await user.agent.get("/vault/items?limit=2&sort=name").expect(200);
    expect(first.body.items.map((i: { name: string }) => i.name)).toEqual(["Note 0", "Note 1"]);
    expect(first.body.total).toBe(5);
    const second = await user.agent
      .get(`/vault/items?limit=2&sort=name&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(second.body.items.map((i: { name: string }) => i.name)).toEqual(["Note 2", "Note 3"]);
  });
});
