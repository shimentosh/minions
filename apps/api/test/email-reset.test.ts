/**
 * Forgotten master password, by email: while email reset is on, the server
 * keeps the user key (encrypted with its own key), and a single-use link hands
 * it back so a new master password can wrap it. The vault stays. The link
 * needs the second factor when one is on, and email reset can be turned off,
 * which deletes the server's copy.
 */
import { randomUUID } from "node:crypto";
import {
  aad,
  deriveMasterKeys,
  fromBase64,
  generateTotp,
  newKdfParams,
  toBase64,
  unwrapKey,
  type VaultKeys,
  wrapKey,
} from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { PrismaService } from "../src/common/prisma.service";
import { testOutbox } from "../src/mail/mailer";
import {
  buildItem,
  createApp,
  login,
  registerUser,
  resetDb,
  TEST_KDF,
  type TestUser,
  WEB,
} from "./helpers";

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

const api = () => request.agent(app.getHttpServer()).set(WEB);
const NEW_PASSWORD = "a brand new master password";

async function userKeyOf(user: TestUser) {
  const keys = (await user.agent.get("/vault/keys").expect(200)).body as VaultKeys;
  const { stretchedKey } = await deriveMasterKeys(user.password, keys.kdf);
  return unwrapKey(stretchedKey, keys.protectedUserKey, aad.userKey(user.userId));
}

/** What the client does after unlocking, when the keys say email reset needs the user key. */
async function enroll(user: TestUser) {
  // Computed first: a request started on the agent while another runs on it is refused.
  const userKey = toBase64(await userKeyOf(user));
  await user.agent.post("/auth/email-recovery/key").send({ userKey }).expect(204);
}

async function requestLink(email: string): Promise<string | null> {
  const before = testOutbox.length;
  await api().post("/auth/reset/request").send({ email }).expect(202);
  // The email is sent after the response.
  for (let i = 0; i < 50 && testOutbox.length === before; i++)
    await new Promise((r) => setTimeout(r, 20));
  const mail = testOutbox.slice(before).findLast((m) => m.to === email);
  return mail?.text.match(/\/reset-password#([A-Za-z0-9_-]{43})/)?.[1] ?? null;
}

/** What the reset page does: open the user key with the link, wrap it under a new password. */
async function reset(user: TestUser, token: string, extra: { code?: string } = {}) {
  const open = await api()
    .post("/auth/reset/open")
    .send({ token, ...extra });
  if (open.status !== 200) return { res: open, agent: null };
  const kdf = { ...TEST_KDF, salt: newKdfParams().salt };
  const { authKey, stretchedKey } = await deriveMasterKeys(NEW_PASSWORD, kdf);
  const agent = request.agent(app.getHttpServer()).set(WEB);
  const res = await agent.post("/auth/reset/complete").send({
    token,
    authKey,
    kdf,
    protectedUserKey: await wrapKey(
      stretchedKey,
      fromBase64(open.body.userKey),
      aad.userKey(user.userId),
    ),
    device: { clientDeviceId: randomUUID(), name: "Reset browser", kind: "web" },
  });
  return { res, agent };
}

describe("email reset", () => {
  it("is on by default and asks the client for the user key once", async () => {
    const user = await registerUser(app);
    const me = await user.agent.get("/auth/me").expect(200);
    expect(me.body.user.emailRecovery).toBe(true);
    let keys = (await user.agent.get("/vault/keys").expect(200)).body as VaultKeys;
    expect(keys.emailRecoveryNeeded).toBe(true);

    await enroll(user);
    keys = (await user.agent.get("/vault/keys").expect(200)).body as VaultKeys;
    expect(keys.emailRecoveryNeeded).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.recoveryKeyEnc).toMatch(/^s1\./);
    // Encrypted with the server's key, not stored as sent.
    expect(row.recoveryKeyEnc).not.toContain(toBase64(await userKeyOf(user)));
  });

  it("refuses a key that does not open the vault", async () => {
    const user = await registerUser(app);
    await user.agent
      .post("/auth/email-recovery/key")
      .send({ userKey: Buffer.alloc(32, 7).toString("base64") })
      .expect(400);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).recoveryKeyEnc,
    ).toBeNull();
  });

  it("sets a new master password from the link and keeps the vault", async () => {
    const user = await registerUser(app);
    await enroll(user);
    const item = await buildItem(user, "LOGIN", "GitHub", {
      url: "https://github.com",
      username: "me",
      password: "Old-Secret-1!",
    });
    await user.agent.post("/vault/items").send(item).expect(201);

    const token = await requestLink(user.email);
    expect(token).toBeTruthy();
    const check = await api().post("/auth/reset/check").send({ token }).expect(200);
    expect(check.body).toEqual({
      email: user.email,
      userId: user.userId,
      twoFactorRequired: false,
      canKeepVault: true,
    });

    const { res, agent } = await reset(user, token!);
    expect(res.status).toBe(200);
    expect(res.body.keys.vaultId).toBe(user.vaultId);
    const items = await agent!.get("/vault/items").expect(200);
    expect((items.body.items ?? items.body).map((i: { id: string }) => i.id)).toContain(item.id);
    await user.agent.get("/auth/me").expect(401);

    expect((await login(app, user)).res.status).toBe(401);
    expect((await login(app, { ...user, password: NEW_PASSWORD })).res.status).toBe(200);

    // The link is spent.
    await api().post("/auth/reset/check").send({ token }).expect(400);
    expect((await reset(user, token!)).res.status).toBe(400);
    const notice = testOutbox.findLast((m) => m.to === user.email)!;
    expect(notice.subject).toBe("Your Minions master password was changed");
    const events = await prisma.securityEvent.findMany({ where: { userId: user.userId } });
    expect(events.map((e) => e.type)).toContain("master_password_recovered");
  });

  it("needs the link to be opened before the new password is accepted", async () => {
    const user = await registerUser(app);
    await enroll(user);
    const token = (await requestLink(user.email))!;
    const kdf = { ...TEST_KDF, salt: newKdfParams().salt };
    const { authKey } = await deriveMasterKeys(NEW_PASSWORD, kdf);
    await api()
      .post("/auth/reset/complete")
      .send({
        token,
        authKey,
        kdf,
        protectedUserKey: `v1.${"A".repeat(16)}.${"B".repeat(64)}`,
        device: { clientDeviceId: randomUUID(), name: "Reset browser", kind: "web" },
      })
      .expect(400);
  });

  it("answers the same for an unknown email, and sends nothing", async () => {
    const before = testOutbox.length;
    const res = await api().post("/auth/reset/request").send({ email: "nobody@example.com" });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 100));
    expect(testOutbox.length).toBe(before);
  });

  it("needs the second factor when it is on", async () => {
    const user = await registerUser(app);
    await enroll(user);
    const setup = await user.agent.post("/auth/2fa/setup").expect(200);
    const secret = setup.body.secret as string;
    await user.agent
      .post("/auth/2fa/enable")
      .send({ authKey: user.authKey, code: (await generateTotp(secret)).code })
      .expect(200);

    const token = (await requestLink(user.email))!;
    const check = await api().post("/auth/reset/check").send({ token }).expect(200);
    expect(check.body.twoFactorRequired).toBe(true);
    expect((await reset(user, token)).res.status).toBe(401);
    expect((await reset(user, token, { code: "000000" })).res.status).toBe(401);
    const ok = await reset(user, token, {
      code: (await generateTotp(secret, Date.now() + 30_000)).code,
    });
    expect(ok.res.status).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(after.twoFactorEnabled).toBe(true);
  });

  it("can be turned off, which deletes the key and stops links", async () => {
    const user = await registerUser(app);
    await enroll(user);
    const token = (await requestLink(user.email))!;

    await user.agent
      .post("/auth/email-recovery")
      .send({ authKey: Buffer.alloc(32, 1).toString("base64"), enabled: false })
      .expect(403);
    await user.agent
      .post("/auth/email-recovery")
      .send({ authKey: user.authKey, enabled: false })
      .expect(204);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.emailRecovery).toBe(false);
    expect(row.recoveryKeyEnc).toBeNull();
    // The link sent before is gone, and no client is asked for the key again.
    await api().post("/auth/reset/check").send({ token }).expect(400);
    const keys = (await user.agent.get("/vault/keys").expect(200)).body as VaultKeys;
    expect(keys.emailRecoveryNeeded).toBe(false);
    const userKey = toBase64(await userKeyOf(user));
    await user.agent.post("/auth/email-recovery/key").send({ userKey }).expect(204);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).recoveryKeyEnc,
    ).toBeNull();

    // A new request (after the cooldown) sends a link that can only start fresh.
    await prisma.accountReset.deleteMany({ where: { userId: user.userId } });
    const fresh = (await requestLink(user.email))!;
    expect(testOutbox.findLast((m) => m.to === user.email)!.text).toMatch(/turned off/);
    const check = await api().post("/auth/reset/check").send({ token: fresh }).expect(200);
    expect(check.body.canKeepVault).toBe(false);
    await api().post("/auth/reset/open").send({ token: fresh }).expect(400);

    // Turning it back on needs the master password and the user key.
    await user.agent
      .post("/auth/email-recovery")
      .send({ authKey: user.authKey, enabled: true })
      .expect(400);
    await user.agent
      .post("/auth/email-recovery")
      .send({ authKey: user.authKey, enabled: true, userKey })
      .expect(204);
    expect((await user.agent.get("/auth/me").expect(200)).body.user.emailRecovery).toBe(true);
  });

  it("does not send a second link within the cooldown", async () => {
    const user = await registerUser(app);
    await enroll(user);
    expect(await requestLink(user.email)).toBeTruthy();
    expect(await requestLink(user.email)).toBeNull();
  });
});
