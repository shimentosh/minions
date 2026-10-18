/**
 * Forgotten master password, the other choice on the reset page: start fresh.
 * The emailed link (sent whether or not email reset is on) gives a new master
 * password and an empty vault; the old vault is deleted. It works once,
 * expires, is stored only as a hash, opens nothing of the old vault, needs the
 * second factor when one is on, and leaves the person's workspaces usable.
 */
import { randomUUID } from "node:crypto";
import {
  createAccountKeys,
  generateKey,
  generateTotp,
  generateUserKeyPair,
  protectPrivateKey,
  sealContext,
  sealKey,
  type WorkspaceMember,
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

async function resetToken(email: string): Promise<string> {
  const before = testOutbox.length;
  await api().post("/auth/reset/request").send({ email }).expect(202);
  // The link is sent after the response.
  return vi.waitFor(() => {
    const mail = testOutbox.slice(before).findLast((m) => m.to === email);
    const token = mail?.text.match(/\/reset-password#([A-Za-z0-9_-]{43})/)?.[1];
    if (!token) throw new Error(`no reset email for ${email}`);
    return token;
  });
}

const NEW_PASSWORD = "a brand new master password";

async function complete(user: TestUser, token: string, extra: { code?: string } = {}) {
  const vaultId = randomUUID();
  const kdf = {
    ...TEST_KDF,
    salt: Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("base64"),
  };
  const keys = await createAccountKeys(NEW_PASSWORD, user.userId, vaultId, kdf);
  const agent = request.agent(app.getHttpServer()).set(WEB);
  const res = await agent.post("/auth/reset/start-over").send({
    token,
    ...extra,
    vaultId,
    authKey: keys.authKey,
    kdf,
    protectedUserKey: keys.protectedUserKey,
    protectedVaultKey: keys.protectedVaultKey,
    device: { clientDeviceId: randomUUID(), name: "Reset browser", kind: "web" },
  });
  return { res, agent, vaultId };
}

async function withKeyPair(user: TestUser) {
  const pair = await generateUserKeyPair();
  await user.agent
    .post("/account/keypair")
    .send({
      publicKey: pair.publicKey,
      protectedPrivateKey: await protectPrivateKey(generateKey(), pair.privateKey, user.userId),
    })
    .expect(204);
  return pair.publicKey;
}

describe("starting over from a reset link", () => {
  it("answers the same for unknown addresses and sends nothing", async () => {
    const before = testOutbox.length;
    const res = await api()
      .post("/auth/reset/request")
      .send({ email: "nobody@example.com" })
      .expect(202);
    expect(res.body).toEqual({});
    await new Promise((r) => setTimeout(r, 50));
    expect(testOutbox.length).toBe(before);
  });

  it("emails a single-use link in the fragment, stored only as a hash", async () => {
    const user = await registerUser(app);
    const token = await resetToken(user.email);
    const mail = testOutbox.findLast((m) => m.to === user.email)!;
    expect(mail.text).not.toMatch(/reset-password\?/);
    expect(mail.text).toContain("start fresh");
    const rows = await prisma.accountReset.findMany({ where: { userId: user.userId } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);

    const check = await api().post("/auth/reset/check").send({ token }).expect(200);
    expect(check.body).toEqual({
      email: user.email,
      userId: user.userId,
      twoFactorRequired: false,
      canKeepVault: false,
    });
    await api()
      .post("/auth/reset/check")
      .send({ token: "A".repeat(43) })
      .expect(400);

    expect((await complete(user, token)).res.status).toBe(200);
    expect((await complete(user, token)).res.status).toBe(400);
    await api().post("/auth/reset/check").send({ token }).expect(400);
  });

  it("does not resend within the cooldown, and expired links stop working", async () => {
    const user = await registerUser(app);
    const token = await resetToken(user.email);
    const sent = testOutbox.filter((m) => m.to === user.email).length;
    await api().post("/auth/reset/request").send({ email: user.email }).expect(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(testOutbox.filter((m) => m.to === user.email).length).toBe(sent);
    await prisma.accountReset.updateMany({
      where: { userId: user.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await complete(user, token)).res.status).toBe(400);
  });

  it("deletes the old vault and sessions, and signs in with the new password", async () => {
    const user = await registerUser(app);
    const body = await buildItem(user, "LOGIN", "GitHub", {
      url: "https://github.com",
      username: "me",
      password: "Old-Secret-1!",
    });
    await user.agent.post("/vault/items").send(body).expect(201);
    await prisma.share.create({
      data: {
        id: randomUUID(),
        userId: user.userId,
        vaultId: user.vaultId,
        label: "GitHub",
        ciphertext: "ct",
      },
    });
    await withKeyPair(user);

    const token = await resetToken(user.email);
    const { res, agent, vaultId } = await complete(user, token);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.keys.userId).toBe(user.userId);
    expect(res.body.keys.vaultId).toBe(vaultId);
    expect(res.body.keys.publicKey).toBeNull();

    // The old session is gone; the new one works and the vault is empty.
    await user.agent.get("/auth/me").expect(401);
    const me = await agent.get("/auth/me").expect(200);
    expect(me.body.user.email).toBe(user.email);
    expect(me.body.user.emailVerified).toBe(true);
    const items = await agent.get("/vault/items").expect(200);
    expect(items.body.items ?? items.body).toHaveLength(0);
    expect(await prisma.vault.findUnique({ where: { id: user.vaultId } })).toBeNull();
    expect(await prisma.vaultItem.count({ where: { id: body.id } })).toBe(0);
    expect(await prisma.share.count({ where: { userId: user.userId } })).toBe(0);

    // The old password no longer signs in; the new one does.
    expect((await login(app, user)).res.status).toBe(401);
    expect((await login(app, { ...user, password: NEW_PASSWORD })).res.status).toBe(200);

    const events = await prisma.securityEvent.findMany({ where: { userId: user.userId } });
    expect(events.map((e) => e.type)).toContain("account_reset");
    const notice = testOutbox.findLast((m) => m.to === user.email)!;
    expect(notice.subject).toBe("Your Minions account was reset");
  });

  it("works with email reset off, and drops the old backup codes", async () => {
    const user = await registerUser(app);
    await user.agent
      .post("/auth/email-recovery")
      .send({ authKey: user.authKey, enabled: false })
      .expect(204);
    await prisma.backupCode.create({
      data: { userId: user.userId, proofHash: "h", protectedUserKey: "k" },
    });
    const token = await resetToken(user.email);
    const mail = testOutbox.findLast((m) => m.to === user.email)!;
    expect(mail.text).toMatch(/turned off/);
    // Keeping the vault is not possible without the server's copy of the key.
    await api().post("/auth/reset/open").send({ token }).expect(400);

    const { res } = await complete(user, token);
    expect(res.status).toBe(200);
    expect(await prisma.backupCode.count({ where: { userId: user.userId } })).toBe(0);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(after.emailRecovery).toBe(false);
    expect(after.recoveryKeyEnc).toBeNull();
  });

  it("asks the client for the new user key when email reset is on", async () => {
    const user = await registerUser(app);
    const { res } = await complete(user, await resetToken(user.email));
    expect(res.status).toBe(200);
    expect(res.body.keys.emailRecoveryNeeded).toBe(true);
  });

  it("needs the second factor when it is on, and counts wrong codes", async () => {
    const user = await registerUser(app);
    const setup = await user.agent.post("/auth/2fa/setup").expect(200);
    const secret = setup.body.secret as string;
    const enabled = await user.agent
      .post("/auth/2fa/enable")
      .send({ authKey: user.authKey, code: (await generateTotp(secret)).code })
      .expect(200);
    const recovery = enabled.body.recoveryCodes[0] as string;

    const token = await resetToken(user.email);
    const check = await api().post("/auth/reset/check").send({ token }).expect(200);
    expect(check.body.twoFactorRequired).toBe(true);

    expect((await complete(user, token)).res.status).toBe(401);
    expect((await complete(user, token, { code: "000000" })).res.status).toBe(401);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.failedLoginCount).toBe(2);

    const { res } = await complete(user, token, { code: recovery });
    expect(res.status).toBe(200);
    // Two-factor sign-in stays on: it does not depend on the old keys.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(after.twoFactorEnabled).toBe(true);
    expect(after.failedLoginCount).toBe(0);
  });

  it("hands owned workspaces to an admin, deletes empty ones, and leaves others", async () => {
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    const member = await registerUser(app);
    const ownerKey = await withKeyPair(owner);
    const adminKey = await withKeyPair(admin);
    await withKeyPair(member);

    async function workspace(name: string, by: TestUser, publicKey: string) {
      const id = randomUUID();
      const key = generateKey();
      await by.agent
        .post("/workspaces")
        .send({
          id,
          name,
          protectedWorkspaceKey: await sealKey(
            publicKey,
            key,
            sealContext.workspaceKey(id, by.userId),
          ),
        })
        .expect(201);
      return { id, key };
    }
    async function join(
      ws: { id: string; key: Uint8Array<ArrayBuffer> },
      by: TestUser,
      user: TestUser,
      role: "ADMIN" | "MEMBER",
    ) {
      await by.agent.post(`/workspaces/${ws.id}/members`).send({ email: user.email, role });
      const inv = await user.agent.get("/workspaces/invitations").expect(200);
      const invite = inv.body.find((i: { workspaceId: string }) => i.workspaceId === ws.id);
      await user.agent.post(`/workspaces/invitations/${invite.id}/accept`).expect(200);
      const members = (await by.agent.get(`/workspaces/${ws.id}/members`).expect(200))
        .body as WorkspaceMember[];
      const m = members.find((x) => x.userId === user.userId)!;
      await by.agent
        .post(`/workspaces/${ws.id}/members/${m.id}/confirm`)
        .send({
          protectedWorkspaceKey: await sealKey(
            m.publicKey!,
            ws.key,
            sealContext.workspaceKey(ws.id, user.userId),
          ),
        })
        .expect(204);
    }

    const team = await workspace("Team", owner, ownerKey);
    await join(team, owner, member, "MEMBER");
    await join(team, owner, admin, "ADMIN");
    const solo = await workspace("Solo", owner, ownerKey);
    const theirs = await workspace("Theirs", admin, adminKey);
    await join(theirs, admin, owner, "MEMBER");

    const { res } = await complete(owner, await resetToken(owner.email));
    expect(res.status).toBe(200);

    // The admin, not the earlier-joined member, becomes the owner; the workspace needs re-keying.
    const teamMembers = await prisma.workspaceMember.findMany({ where: { workspaceId: team.id } });
    expect(teamMembers.map((m) => [m.userId, m.role]).sort()).toEqual(
      [
        [admin.userId, "OWNER"],
        [member.userId, "MEMBER"],
      ].sort(),
    );
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: team.id } })).rekeyNeeded).toBe(
      true,
    );
    expect(await prisma.workspace.findUnique({ where: { id: solo.id } })).toBeNull();
    const theirMembers = await prisma.workspaceMember.findMany({
      where: { workspaceId: theirs.id },
    });
    expect(theirMembers.map((m) => m.userId)).toEqual([admin.userId]);
  });
});
