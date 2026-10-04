import { generateTotp } from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { PrismaService } from "../src/common/prisma.service";
import { createApp, login, registerUser, resetDb, vaultKeyFrom, WEB } from "./helpers";

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

describe("registration and login", () => {
  it("registers, sets an HttpOnly cookie and never stores the auth key", async () => {
    const user = await registerUser(app);
    const me = await user.agent.get("/auth/me").expect(200);
    expect(me.body.user.email).toBe(user.email);
    expect(me.body.session.vaultUnlocked).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.authHash).toMatch(/^\$argon2id\$/);
    expect(row.authHash).not.toContain(user.authKey);
    expect(JSON.stringify(row)).not.toContain(user.password);
  });

  it("returns the same KDF shape for unknown emails (no enumeration)", async () => {
    const user = await registerUser(app);
    const known = await request(app.getHttpServer())
      .post("/auth/prelogin")
      .set(WEB)
      .send({ email: user.email })
      .expect(200);
    const unknown = await request(app.getHttpServer())
      .post("/auth/prelogin")
      .set(WEB)
      .send({ email: "ghost@example.com" })
      .expect(200);
    const again = await request(app.getHttpServer())
      .post("/auth/prelogin")
      .set(WEB)
      .send({ email: "ghost@example.com" })
      .expect(200);
    expect(Object.keys(unknown.body.kdf).sort()).toEqual(Object.keys(known.body.kdf).sort());
    expect(unknown.body.kdf.salt).toBe(again.body.kdf.salt);
  });

  it("logs in with the right master password and recovers the vault key", async () => {
    const user = await registerUser(app);
    const { agent, res, stretchedKey } = await login(app, user);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.token).toBeUndefined(); // web: cookie only
    const vaultKey = await vaultKeyFrom(stretchedKey, res.body.keys);
    expect(Buffer.from(vaultKey).equals(Buffer.from(user.vaultKey))).toBe(true);
    await agent.get("/auth/me").expect(200);
  });

  it("rejects a wrong master password and locks the account after repeated failures", async () => {
    const user = await registerUser(app);
    const wrong = { ...user, password: "wrong password" };
    for (let i = 0; i < 5; i++) expect((await login(app, wrong)).res.status).toBe(401);
    const locked = await login(app, user);
    expect(locked.res.status).toBe(429);
    expect(locked.res.body.code).toBe("ACCOUNT_LOCKED");
    const events = await prisma.securityEvent.findMany({ where: { userId: user.userId } });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["login_failed", "account_locked"]),
    );
  });

  it("bearer clients get a token in the body", async () => {
    const user = await registerUser(app);
    const { res } = await login(app, user, {
      kind: "extension",
      clientDeviceId: "ext-device-0001",
    });
    expect(res.body.token).toEqual(expect.any(String));
    await request(app.getHttpServer())
      .get("/auth/me")
      .set(WEB)
      .set("authorization", `Bearer ${res.body.token}`)
      .expect(200);
  });

  it("requires the client header (CSRF defence)", async () => {
    const user = await registerUser(app);
    const cookie = (await login(app, user)).res.headers["set-cookie"]!;
    await request(app.getHttpServer()).get("/auth/me").set("cookie", cookie).expect(403);
  });

  it("logout revokes the session", async () => {
    const user = await registerUser(app);
    await user.agent.post("/auth/logout").expect(204);
    await user.agent.get("/auth/me").expect(401);
  });

  it("records a security event for a new device", async () => {
    const user = await registerUser(app);
    await login(app, user, { clientDeviceId: "second-device-001" });
    const events = await prisma.securityEvent.findMany({
      where: { userId: user.userId, type: "new_device" },
    });
    expect(events).toHaveLength(1);
  });
});

describe("two-factor authentication", () => {
  async function enable2fa(user: Awaited<ReturnType<typeof registerUser>>) {
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

  it("requires a code after the password, and stores the TOTP secret encrypted", async () => {
    const user = await registerUser(app);
    const { secret, recoveryCodes } = await enable2fa(user);
    expect(recoveryCodes).toHaveLength(10);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.twoFactorSecretEnc).not.toContain(secret);
    const codes = await prisma.recoveryCode.findMany({ where: { userId: user.userId } });
    expect(codes.every((c) => !recoveryCodes.some((rc) => c.codeHash.includes(rc)))).toBe(true);

    const { agent, res } = await login(app, user);
    expect(res.body).toEqual({ status: "two_factor_required", methods: ["totp"] });
    await agent.get("/auth/me").expect(401);
    await agent.get("/vault/items").expect(401);
    await agent.post("/auth/2fa/verify").send({ code: "000000" }).expect(401);
    // The code used to enable 2FA cannot be replayed; the next step's code is fresh.
    const { code } = await generateTotp(secret, Date.now() + 30_000);
    const verified = await agent.post("/auth/2fa/verify").send({ code }).expect(200);
    expect(verified.body.keys.vaultId).toBe(user.vaultId);
    await agent.get("/auth/me").expect(200);
  });

  it("accepts a recovery code once", async () => {
    const user = await registerUser(app);
    const { recoveryCodes } = await enable2fa(user);
    const first = await login(app, user);
    await first.agent.post("/auth/2fa/verify").send({ code: recoveryCodes[0] }).expect(200);
    const second = await login(app, user);
    await second.agent.post("/auth/2fa/verify").send({ code: recoveryCodes[0] }).expect(401);
  });

  it("revokes the pending session after too many wrong codes", async () => {
    const user = await registerUser(app);
    await enable2fa(user);
    const { agent } = await login(app, user);
    for (let i = 0; i < 5; i++)
      await agent.post("/auth/2fa/verify").send({ code: "123456" }).expect(401);
    await agent.post("/auth/2fa/verify").send({ code: "123456" }).expect(401);
    const pending = await prisma.session.findMany({
      where: { userId: user.userId, state: "PENDING_2FA" },
    });
    expect(pending.every((s) => s.revokedAt)).toBe(true);
  });
});

describe("sessions and devices", () => {
  it("revokes a single session", async () => {
    const user = await registerUser(app);
    const other = await login(app, user, { clientDeviceId: "laptop-0000001" });
    const sessions = await user.agent.get("/sessions").expect(200);
    const target = sessions.body.find((s: { current: boolean }) => !s.current);
    await user.agent.delete(`/sessions/${target.id}`).expect(204);
    await other.agent.get("/auth/me").expect(401);
    await user.agent.get("/auth/me").expect(200);
  });

  it("revoking a device signs it out everywhere", async () => {
    const user = await registerUser(app);
    const other = await login(app, user, { clientDeviceId: "phone-00000001" });
    const devices = await user.agent.get("/devices").expect(200);
    const phone = devices.body.find((d: { current: boolean }) => !d.current);
    await user.agent.delete(`/devices/${phone.id}`).expect(204);
    await other.agent.get("/auth/me").expect(401);
  });

  it("emergency lock revokes every session including the caller's", async () => {
    const user = await registerUser(app);
    const other = await login(app, user, { clientDeviceId: "desktop-0000001" });
    await user.agent.post("/vault/emergency-lock").expect(200);
    await user.agent.get("/auth/me").expect(401);
    await other.agent.get("/auth/me").expect(401);
  });

  it("log out all other sessions keeps the current one", async () => {
    const user = await registerUser(app);
    const other = await login(app, user, { clientDeviceId: "tablet-0000001" });
    const res = await user.agent.post("/sessions/revoke-all").send({}).expect(200);
    expect(res.body.revoked).toBe(1);
    await other.agent.get("/auth/me").expect(401);
    await user.agent.get("/auth/me").expect(200);
  });

  it("changing the master password re-wraps the key and revokes other sessions", async () => {
    const { deriveMasterKeys, wrapKey, aad, unwrapKey } = await import("@minions/core");
    const user = await registerUser(app);
    const other = await login(app, user, { clientDeviceId: "other-00000001" });
    const keys = (await user.agent.get("/vault/keys").expect(200)).body;
    const { stretchedKey } = await deriveMasterKeys(user.password, keys.kdf);
    const userKey = await unwrapKey(stretchedKey, keys.protectedUserKey, aad.userKey(user.userId));
    const newKdf = { ...keys.kdf, salt: Buffer.alloc(16, 7).toString("base64") };
    const next = await deriveMasterKeys("a brand new master password", newKdf);
    await user.agent
      .post("/auth/change-password")
      .send({
        currentAuthKey: user.authKey,
        newAuthKey: next.authKey,
        kdf: newKdf,
        protectedUserKey: await wrapKey(next.stretchedKey, userKey, aad.userKey(user.userId)),
      })
      .expect(204);
    await other.agent.get("/auth/me").expect(401);
    const relog = await login(app, { ...user, password: "a brand new master password" });
    expect(relog.res.status).toBe(200);
    const vaultKey = await vaultKeyFrom(relog.stretchedKey, relog.res.body.keys);
    expect(Buffer.from(vaultKey).equals(Buffer.from(user.vaultKey))).toBe(true);
  });
});

describe("rate limiting", () => {
  afterEach(() => {
    delete process.env.MINIONS_TEST_THROTTLE;
  });

  it("throttles repeated login attempts from one client", async () => {
    process.env.MINIONS_TEST_THROTTLE = "1";
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(app.getHttpServer())
        .post("/auth/prelogin")
        .set(WEB)
        .send({ email: "rate@example.com" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe("rate limiting across instances (Redis)", () => {
  afterEach(() => {
    delete process.env.MINIONS_TEST_THROTTLE;
    delete process.env.MINIONS_TEST_REDIS;
    delete process.env.MINIONS_THROTTLE_PREFIX;
  });

  it.runIf(!!process.env.REDIS_URL)("two API instances share one limit", async () => {
    process.env.MINIONS_TEST_THROTTLE = "1";
    process.env.MINIONS_TEST_REDIS = "1";
    process.env.MINIONS_THROTTLE_PREFIX = `minions:test:${Date.now()}:`;
    const a = await createApp();
    const b = await createApp();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const target = i % 2 === 0 ? a.app : b.app;
        const res = await request(target.getHttpServer())
          .post("/auth/prelogin")
          .set(WEB)
          .send({ email: "shared@example.com" });
        statuses.push(res.status);
      }
      // 10 per minute on auth routes, counted together even though the
      // requests alternate between two separate instances.
      expect(statuses.filter((s) => s === 200)).toHaveLength(10);
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      await a.app.close();
      await b.app.close();
    }
  });
});
