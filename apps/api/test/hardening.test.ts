/**
 * Security hardening tests: brute force under concurrency, second-factor
 * replay, locked-session key exposure, cross-account access (IDOR/BOLA),
 * public-suffix-safe site matching, input validation and production config.
 */
import { randomUUID } from "node:crypto";
import { encryptString, generateTotp } from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import type { PrismaService } from "../src/common/prisma.service";
import { loadConfig, resetConfig } from "../src/config";
import { buildItem, createApp, login, registerUser, resetDb, type TestUser } from "./helpers";

let app: INestApplication;
let prisma: PrismaService;

beforeAll(async () => {
  ({ app, prisma } = await createApp());
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb(prisma);
});

async function enable2fa(user: TestUser) {
  const setup = await user.agent.post("/auth/2fa/setup").expect(200);
  const { code } = await generateTotp(setup.body.secret);
  const enabled = await user.agent
    .post("/auth/2fa/enable")
    .send({ authKey: user.authKey, code })
    .expect(200);
  return {
    secret: setup.body.secret as string,
    recoveryCodes: enabled.body.recoveryCodes as string[],
  };
}

/** A TOTP code from the next 30-second step: valid now (±1 window) but unused. */
async function nextStepCode(secret: string) {
  return (await generateTotp(secret, Date.now() + 30_000)).code;
}

describe("brute-force protection", () => {
  it("counts every one of many parallel wrong passwords and locks the account", async () => {
    const user = await registerUser(app);
    const wrong = { ...user, password: "not the master password" };
    const results = await Promise.all(Array.from({ length: 8 }, () => login(app, wrong)));
    for (const r of results) expect([401, 429]).toContain(r.res.status);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.failedLoginCount).toBe(8);
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // Even the right password is refused while locked.
    expect((await login(app, user)).res.status).toBe(429);
  });

  it("wrong 2FA codes lock the account across fresh sign-ins; the password alone cannot reset the count", async () => {
    const user = await registerUser(app);
    const { secret } = await enable2fa(user);
    // Five sign-ins with the right password, one wrong code each.
    for (let i = 0; i < 5; i++) {
      const { agent, res } = await login(app, user);
      expect(res.body.status).toBe("two_factor_required");
      await agent.post("/auth/2fa/verify").send({ code: "000000" }).expect(401);
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.failedLoginCount).toBe(5);
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // Locked: no new sign-in, and the right code does not help either.
    expect((await login(app, user)).res.status).toBe(429);
    await prisma.user.update({ where: { id: user.userId }, data: { lockedUntil: null } });
    const { agent } = await login(app, user);
    await prisma.user.update({
      where: { id: user.userId },
      data: { lockedUntil: new Date(Date.now() + 60_000) },
    });
    await agent
      .post("/auth/2fa/verify")
      .send({ code: await nextStepCode(secret) })
      .expect(429);
  });

  it("a successful second factor clears the failure count", async () => {
    const user = await registerUser(app);
    const { secret } = await enable2fa(user);
    const first = await login(app, user);
    await first.agent.post("/auth/2fa/verify").send({ code: "000000" }).expect(401);
    const second = await login(app, user);
    await second.agent
      .post("/auth/2fa/verify")
      .send({ code: await nextStepCode(secret) })
      .expect(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.failedLoginCount).toBe(0);
  });

  it("wrong master passwords at unlock feed the same lockout", async () => {
    const user = await registerUser(app);
    await user.agent.post("/vault/lock").expect(204);
    const bad = Buffer.alloc(32, 1).toString("base64");
    for (let i = 0; i < 5; i++)
      await user.agent.post("/vault/unlock").send({ authKey: bad }).expect(403);
    await user.agent.post("/vault/unlock").send({ authKey: user.authKey }).expect(429);
  });

  it("parallel wrong share passphrases are all counted", async () => {
    const user = await registerUser(app);
    const id = randomUUID();
    await user.agent
      .post("/shares")
      .send({
        id,
        label: "x",
        ciphertext: await encryptString(user.vaultKey, "payload", `share:${id}`),
        expiresInMinutes: 60,
        maxViews: null,
        includesTotp: false,
        passphraseSalt: Buffer.alloc(16, 3).toString("base64"),
        accessHash: "a".repeat(64),
      })
      .expect(201);
    const { default: request } = await import("supertest");
    await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app.getHttpServer())
          .post(`/public/shares/${id}/open`)
          .set({ "x-minions-client": "web" })
          .send({ accessToken: "b".repeat(64) }),
      ),
    );
    const row = await prisma.share.findUniqueOrThrow({ where: { id } });
    expect(row.failedAttempts).toBe(6);
  });
});

describe("second factor replay", () => {
  it("a TOTP code works once", async () => {
    const user = await registerUser(app);
    const { secret } = await enable2fa(user);
    const code = await nextStepCode(secret);
    const first = await login(app, user);
    await first.agent.post("/auth/2fa/verify").send({ code }).expect(200);
    const second = await login(app, user);
    await second.agent.post("/auth/2fa/verify").send({ code }).expect(401);
  });

  it("a recovery code used by two sign-ins at once works for exactly one", async () => {
    const user = await registerUser(app);
    const { recoveryCodes } = await enable2fa(user);
    const a = await login(app, user);
    const b = await login(app, user);
    const results = await Promise.all([
      a.agent.post("/auth/2fa/verify").send({ code: recoveryCodes[0] }),
      b.agent.post("/auth/2fa/verify").send({ code: recoveryCodes[0] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });
});

describe("a locked session exposes no key material", () => {
  it("returns only KDF parameters until the master password is proven", async () => {
    const user = await registerUser(app);
    await user.agent.post("/vault/lock").expect(204);
    await user.agent.get("/vault/keys").expect(403);
    const kdf = await user.agent.get("/vault/kdf").expect(200);
    expect(Object.keys(kdf.body)).toEqual(["kdf"]);
    expect(JSON.stringify(kdf.body)).not.toMatch(/protected/i);
    const unlocked = await user.agent
      .post("/vault/unlock")
      .send({ authKey: user.authKey })
      .expect(200);
    expect(unlocked.body.keys.protectedUserKey).toBeTruthy();
    await user.agent.get("/vault/keys").expect(200);
  });
});

describe("IDOR / BOLA: ids from another account are never honoured", () => {
  it("covers every item, share, session, device, passkey and activity route", async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const item = await buildItem(alice, "LOGIN", "Alice bank", {
      url: "https://bank.example.com",
      username: "alice",
      password: "alice-pass-77",
    });
    await alice.agent.post("/vault/items").send(item).expect(201);
    await alice.agent.delete(`/vault/items/${item.id}`).expect(204);
    const bobItem = await buildItem(bob, "LOGIN", "Bob", { username: "bob" });
    await bob.agent.post("/vault/items").send(bobItem).expect(201);

    // Items: trash, restore, purge, merge into, versions, the authenticator list.
    await bob.agent.post(`/vault/items/${item.id}/restore`).expect(404);
    await bob.agent.delete(`/vault/items/${item.id}/purge`).expect(404);
    await bob.agent
      .post(`/vault/items/${item.id}/merge`)
      .send({ sourceIds: [bobItem.id] })
      .expect(404);
    const trash = await bob.agent.get("/vault/items?trash=true").expect(200);
    expect(trash.body.items).toHaveLength(0);
    const totp = await bob.agent.get("/vault/items/totp").expect(200);
    expect(totp.body).toHaveLength(0);
    const existing = await bob.agent
      .post("/vault/existing")
      .send({ itemIds: [item.id], noteIds: [] })
      .expect(200);
    expect(existing.body.itemIds).toHaveLength(0);
    const backup = await bob.agent.get("/vault/export").expect(200);
    expect(JSON.stringify(backup.body)).not.toContain(item.id);

    // Shares: Bob cannot share Alice's item, list or revoke her shares.
    const shareId = randomUUID();
    await bob.agent
      .post("/shares")
      .send({
        id: shareId,
        itemId: item.id,
        label: "steal",
        ciphertext: await encryptString(bob.vaultKey, "x", `share:${shareId}`),
        expiresInMinutes: 60,
        maxViews: 1,
        includesTotp: false,
      })
      .expect(404);
    const aliceShare = randomUUID();
    await alice.agent
      .post("/shares")
      .send({
        id: aliceShare,
        label: "mine",
        ciphertext: await encryptString(alice.vaultKey, "x", `share:${aliceShare}`),
        expiresInMinutes: 60,
        maxViews: 1,
        includesTotp: false,
      })
      .expect(201);
    expect((await bob.agent.get("/shares").expect(200)).body).toHaveLength(0);
    await bob.agent.delete(`/shares/${aliceShare}`).expect(404);

    // Sessions, devices, passkeys and activity.
    const aliceSession = await prisma.session.findFirstOrThrow({ where: { userId: alice.userId } });
    const aliceDevice = await prisma.device.findFirstOrThrow({ where: { userId: alice.userId } });
    await bob.agent.delete(`/sessions/${aliceSession.id}`).expect(404);
    await bob.agent.delete(`/devices/${aliceDevice.id}`).expect(404);
    await bob.agent
      .post(`/auth/passkeys/${randomUUID()}/remove`)
      .send({ authKey: bob.authKey })
      .expect(404);
    const activity = await bob.agent.get(`/activity?itemId=${item.id}`).expect(200);
    expect(activity.body.items).toHaveLength(0);
    await alice.agent.get("/auth/me").expect(200);

    // Ids or roles smuggled into a body are rejected, not trusted.
    await bob.agent
      .patch("/users/me/settings")
      .send({ userId: alice.userId, autoLockMinutes: 5 })
      .expect(400);
    await bob.agent
      .post("/vault/items")
      .send({ ...(await buildItem(bob, "LOGIN", "x", { username: "b" })), vaultId: alice.vaultId })
      .expect(400);
  });

  it("a removed (revoked) device's token gets nothing, even with a known item id", async () => {
    const user = await registerUser(app);
    const item = await buildItem(user, "LOGIN", "Mine", { username: "me", password: "pw-123456" });
    await user.agent.post("/vault/items").send(item).expect(201);
    const ext = await login(app, user, { clientDeviceId: "ext-device-001", kind: "extension" });
    const token = ext.res.body.token as string;
    const device = await prisma.device.findFirstOrThrow({
      where: { userId: user.userId, clientDeviceId: "ext-device-001" },
    });
    await user.agent.delete(`/devices/${device.id}`).expect(204);
    const { default: request } = await import("supertest");
    await request(app.getHttpServer())
      .get(`/vault/items/${item.id}`)
      .set({ "x-minions-client": "extension", authorization: `Bearer ${token}` })
      .expect(401);
  });
});

describe("site matching is public-suffix aware", () => {
  it("never offers a login across co.uk, github.io or similar suffixes", async () => {
    const user = await registerUser(app);
    for (const [name, url] of [
      ["Bank", "https://bank.co.uk"],
      ["Pages", "https://alice.github.io"],
      ["Router", "https://192.168.1.1"],
    ])
      await user.agent
        .post("/vault/items")
        .send(await buildItem(user, "LOGIN", name, { url, username: "u" }))
        .expect(201);
    const match = async (host: string) =>
      (await user.agent.get(`/vault/items/match?host=${host}`).expect(200)).body.map(
        (i: { name: string }) => i.name,
      );
    expect(await match("evil.co.uk")).toEqual([]);
    expect(await match("login.bank.co.uk")).toEqual(["Bank"]);
    expect(await match("mallory.github.io")).toEqual([]);
    expect(await match("192.168.1.2")).toEqual([]);
    expect(await match("192.168.1.1")).toEqual(["Router"]);
    expect(await match("xn--bnk-sna.co.uk")).toEqual([]);
  });
});

describe("input validation", () => {
  it("rejects malformed cursors and value-shaped usage fields", async () => {
    const user = await registerUser(app);
    await user.agent.get("/vault/items?cursor=not-a-uuid").expect(400);
    await user.agent.get("/activity?cursor=x';drop table users;--").expect(400);
    const item = await buildItem(user, "LOGIN", "X", { username: "u", password: "pw-99999" });
    await user.agent.post("/vault/items").send(item).expect(201);
    await user.agent
      .post(`/vault/items/${item.id}/usage`)
      .send({ action: "item.copied", field: "my password is hunter2" })
      .expect(400);
    await user.agent
      .post(`/vault/items/${item.id}/usage`)
      .send({ action: "item.copied", field: "password" })
      .expect(204);
    await user.agent.get("/vault/items/match?host=../../etc/passwd").expect(400);
    // Prototype pollution through a JSON body is refused, and pollutes nothing.
    await user.agent
      .post("/vault/items")
      .set("content-type", "application/json")
      .send('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}')
      .expect(400);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("audit", () => {
  it("records security setting changes without values beyond the setting", async () => {
    const user = await registerUser(app);
    await user.agent.patch("/users/me/settings").send({ autoLockMinutes: 240 }).expect(200);
    const ev = await prisma.securityEvent.findFirstOrThrow({
      where: { userId: user.userId, type: "settings_changed" },
    });
    expect(ev.metadata).toEqual({ kind: "autoLockMinutes", to: "240" });
  });

  it("failed sign-ins are logged without the submitted credential", async () => {
    const user = await registerUser(app);
    const { authKey } = await login(app, { ...user, password: "wrong-password-xyz" });
    const dump = JSON.stringify([
      await prisma.activityLog.findMany({ where: { userId: user.userId } }),
      await prisma.securityEvent.findMany({ where: { userId: user.userId } }),
    ]);
    expect(dump).toContain("login_failed");
    expect(dump).not.toContain(authKey);
    expect(dump).not.toContain("wrong-password-xyz");
    expect(dump).not.toContain(user.authKey);
  });
});

describe("production configuration", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetConfig();
  });

  it("refuses to start with development defaults", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://minions:minions_dev_only@db/minions";
    process.env.WEB_ORIGINS = "http://vault.example.com";
    process.env.WEBAUTHN_RP_ID = "localhost";
    resetConfig();
    expect(() => loadConfig()).toThrow(/development password[\s\S]*not https[\s\S]*localhost/);
  });

  it("accepts a hardened configuration", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://minions:Str0ng@db/minions";
    process.env.WEB_ORIGINS = "https://vault.example.com";
    process.env.WEBAUTHN_ORIGINS = "https://vault.example.com";
    process.env.WEBAUTHN_RP_ID = "vault.example.com";
    process.env.EXTENSION_ORIGINS = `chrome-extension://${"a".repeat(32)}`;
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.MAIL_FROM = "Minions <no-reply@vault.example.com>";
    process.env.PUBLIC_WEB_URL = "https://vault.example.com";
    delete process.env.MAILPIT_URL;
    resetConfig();
    expect(loadConfig().env).toBe("production");
  });

  it("refuses a development Mailpit in production", () => {
    process.env.NODE_ENV = "production";
    process.env.MAILPIT_URL = "http://localhost:58025";
    resetConfig();
    expect(() => loadConfig()).toThrow(/MAILPIT_URL is for development only/);
  });

  it("only accepts a Mailpit on this machine", () => {
    process.env.NODE_ENV = "development";
    process.env.MAILPIT_URL = "http://mail.example.com:8025";
    resetConfig();
    expect(() => loadConfig()).toThrow(/MAILPIT_URL must be http:\/\/localhost/);
    process.env.MAILPIT_URL = "http://localhost:58025/";
    resetConfig();
    expect(loadConfig().mail.mailpitUrl).toBe("http://localhost:58025");
  });

  it("never trusts every proxy, so clients can't choose their own IP", () => {
    process.env.TRUST_PROXY = "true";
    resetConfig();
    expect(() => loadConfig()).toThrow(/TRUST_PROXY must name the proxies/);
    process.env.TRUST_PROXY = "2";
    resetConfig();
    expect(loadConfig().trustProxy).toBe(2);
    delete process.env.TRUST_PROXY;
    resetConfig();
    expect(loadConfig().trustProxy).toBe("loopback");
  });
});

describe("health", () => {
  it("answers without a session", async () => {
    const { default: request } = await import("supertest");
    const res = await request(app.getHttpServer())
      .get("/health")
      .set({ "x-minions-client": "health" })
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });
});
