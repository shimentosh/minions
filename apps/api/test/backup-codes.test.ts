/**
 * Forgotten master password: backup codes made on the client wrap the user
 * key, so using one sets a new master password and keeps everything. A code
 * works once, is stored only as a hash of its proof, needs the second factor
 * when one is on, and still works when wrong passwords have locked sign-in.
 */
import { randomUUID } from "node:crypto";
import {
  aad,
  backupCodeKeys,
  createBackupCodes,
  deriveMasterKeys,
  generateTotp,
  newKdfParams,
  unwrapKey,
  unwrapWithBackupCode,
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

async function makeCodes(user: TestUser) {
  const set = await createBackupCodes(await userKeyOf(user), user.userId);
  await user.agent
    .post("/auth/backup-codes")
    .send({ authKey: user.authKey, codes: set.entries })
    .expect(204);
  return set.codes;
}

/** What the forgot-password screen does: open the user key with the code, wrap it under a new password. */
async function recover(user: TestUser, code: string, extra: { code?: string } = {}) {
  const { proof } = await backupCodeKeys(code);
  const check = await api().post("/auth/recover/check").send({ email: user.email, proof });
  if (check.status !== 200) return { res: check, agent: null };
  const userKey = await unwrapWithBackupCode(code, check.body.protectedUserKey, user.userId);
  const kdf = { ...TEST_KDF, salt: newKdfParams().salt };
  const { authKey, stretchedKey } = await deriveMasterKeys(NEW_PASSWORD, kdf);
  const agent = request.agent(app.getHttpServer()).set(WEB);
  const res = await agent.post("/auth/recover/complete").send({
    email: user.email,
    proof,
    ...extra,
    authKey,
    kdf,
    protectedUserKey: await wrapKey(stretchedKey, userKey, aad.userKey(user.userId)),
    device: { clientDeviceId: randomUUID(), name: "Recovery browser", kind: "web" },
  });
  return { res, agent, check };
}

describe("backup codes", () => {
  it("are stored only as a hash of the proof, and replaced as a set", async () => {
    const user = await registerUser(app);
    expect((await user.agent.get("/auth/backup-codes").expect(200)).body).toMatchObject({
      total: 0,
      remaining: 0,
    });
    const codes = await makeCodes(user);
    const rows = await prisma.backupCode.findMany({ where: { userId: user.userId } });
    expect(rows).toHaveLength(8);
    const { proof } = await backupCodeKeys(codes[0]!);
    expect(JSON.stringify(rows)).not.toContain(proof);
    expect(JSON.stringify(rows)).not.toContain(codes[0]!.replace(/-/g, ""));

    const fresh = await makeCodes(user);
    expect(await prisma.backupCode.count({ where: { userId: user.userId } })).toBe(8);
    expect((await recover(user, codes[0]!)).res.status).toBe(400);
    expect((await recover(user, fresh[0]!)).res.status).toBe(200);
  });

  it("need the master password to be made", async () => {
    const user = await registerUser(app);
    const set = await createBackupCodes(await userKeyOf(user), user.userId);
    await user.agent
      .post("/auth/backup-codes")
      .send({ authKey: Buffer.alloc(32, 1).toString("base64"), codes: set.entries })
      .expect(403);
  });

  it("set a new master password and keep the vault, once per code", async () => {
    const user = await registerUser(app);
    const item = await buildItem(user, "LOGIN", "GitHub", {
      url: "https://github.com",
      username: "me",
      password: "Old-Secret-1!",
    });
    await user.agent.post("/vault/items").send(item).expect(201);
    const codes = await makeCodes(user);

    const { res, agent } = await recover(user, codes[2]!);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.keys.vaultId).toBe(user.vaultId);

    // Same vault, same items; the other session is signed out.
    const items = await agent!.get("/vault/items").expect(200);
    expect((items.body.items ?? items.body).map((i: { id: string }) => i.id)).toContain(item.id);
    await user.agent.get("/auth/me").expect(401);

    expect((await login(app, user)).res.status).toBe(401);
    expect((await login(app, { ...user, password: NEW_PASSWORD })).res.status).toBe(200);

    // The code is spent; the others still work.
    expect((await recover(user, codes[2]!)).res.status).toBe(400);
    expect((await user.agent.get("/auth/backup-codes")).status).toBe(401);
    const status = await agent!.get("/auth/backup-codes").expect(200);
    expect(status.body.remaining).toBe(7);

    const events = await prisma.securityEvent.findMany({ where: { userId: user.userId } });
    expect(events.map((e) => e.type)).toContain("master_password_recovered");
    const notice = testOutbox.findLast((m) => m.to === user.email)!;
    expect(notice.subject).toBe("Your Minions master password was changed");
  });

  it("answer the same for an unknown email and for another account's code", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const codes = await makeCodes(a);
    const { proof } = await backupCodeKeys(codes[0]!);
    const other = await api().post("/auth/recover/check").send({ email: b.email, proof });
    const unknown = await api()
      .post("/auth/recover/check")
      .send({ email: "nobody@example.com", proof });
    expect(other.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(other.body.message).toBe(unknown.body.message);
  });

  it("work while wrong passwords have locked sign-in, and clear the lock", async () => {
    const user = await registerUser(app);
    const codes = await makeCodes(user);
    const wrong = { ...user, password: "not the master password" };
    for (let i = 0; i < 5; i++) await login(app, wrong);
    const locked = await login(app, user);
    expect(locked.res.status).toBe(429);
    expect(locked.res.body.message).toMatch(/Try again in 1 minute/);

    expect((await recover(user, codes[0]!)).res.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it("need the second factor when it is on", async () => {
    const user = await registerUser(app);
    const codes = await makeCodes(user);
    const setup = await user.agent.post("/auth/2fa/setup").expect(200);
    const secret = setup.body.secret as string;
    await user.agent
      .post("/auth/2fa/enable")
      .send({ authKey: user.authKey, code: (await generateTotp(secret)).code })
      .expect(200);

    const first = await recover(user, codes[0]!);
    expect(first.check?.body.twoFactorRequired).toBe(true);
    expect(first.res.status).toBe(401);
    expect((await recover(user, codes[0]!, { code: "000000" })).res.status).toBe(401);
    const ok = await recover(user, codes[0]!, {
      code: (await generateTotp(secret, Date.now() + 30_000)).code,
    });
    expect(ok.res.status).toBe(200);
    // Two-factor stays on: only the master password changed.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(after.twoFactorEnabled).toBe(true);
  });
});

describe("lockout", () => {
  it("locks on every fifth failure in a row, not on each one after", async () => {
    const user = await registerUser(app);
    const wrong = { ...user, password: "not the master password" };
    for (let i = 0; i < 5; i++) await login(app, wrong);
    // The first lock ends; the next wrong password does not lock again at once.
    await prisma.user.update({ where: { id: user.userId }, data: { lockedUntil: null } });
    expect((await login(app, wrong)).res.status).toBe(401);
    expect((await login(app, user)).res.status).toBe(200);
  });
});
