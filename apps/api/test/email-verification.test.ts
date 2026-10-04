/**
 * Email verification: an address counts as identity only after a link sent to
 * it was opened. Links are single use, expire, and are stored only as hashes;
 * workspace invitations are invisible and unusable until the address is proven.
 */
import { randomUUID } from "node:crypto";
import {
  generateKey,
  generateUserKeyPair,
  protectPrivateKey,
  sealContext,
  sealKey,
} from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { PrismaService } from "../src/common/prisma.service";
import { loadConfig } from "../src/config";
import { testOutbox } from "../src/mail/mailer";
import { createApp, registerUser, resetDb, type TestUser, verificationToken, WEB } from "./helpers";

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

const verify = (token: string) =>
  request(app.getHttpServer()).post("/auth/email/verify").set(WEB).send({ token });

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

describe("email verification", () => {
  it("sends a link at sign-up; it works once and is stored only as a hash", async () => {
    const user = await registerUser(app, undefined, undefined, { verifyEmail: false });
    expect((await user.agent.get("/auth/me").expect(200)).body.user.emailVerified).toBe(false);
    const mail = testOutbox.findLast((m) => m.to === user.email)!;
    expect(mail.text).toContain(`${loadConfig().mail.publicWebUrl}/verify-email#`);
    // The token travels in the fragment, never in a query string.
    expect(mail.text).not.toMatch(/verify-email\?/);
    const token = verificationToken(user.email);
    const rows = await prisma.emailVerification.findMany({ where: { userId: user.userId } });
    expect(JSON.stringify(rows)).not.toContain(token);

    await verify(token).expect(204);
    expect((await user.agent.get("/auth/me").expect(200)).body.user.emailVerified).toBe(true);
    await verify(token).expect(400);
    const ev = await prisma.securityEvent.findFirst({
      where: { userId: user.userId, type: "email_verified" },
    });
    expect(ev).toBeTruthy();
  });

  it("rejects wrong, expired and superseded links", async () => {
    const user = await registerUser(app, undefined, undefined, { verifyEmail: false });
    await verify("A".repeat(43)).expect(400);
    await verify("not a token").expect(400);
    const first = verificationToken(user.email);
    await user.agent.post("/auth/email/verify-request").expect(200);
    const second = verificationToken(user.email);
    expect(second).not.toBe(first);
    await verify(first).expect(400);
    await prisma.emailVerification.updateMany({
      where: { userId: user.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await verify(second).expect(400);
    expect((await user.agent.get("/auth/me").expect(200)).body.user.emailVerified).toBe(false);
  });

  it("a link opened twice at once verifies once", async () => {
    const user = await registerUser(app, undefined, undefined, { verifyEmail: false });
    const token = verificationToken(user.email);
    const results = await Promise.all([verify(token), verify(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
  });

  it("someone who registered another person's address cannot see or take their invitations", async () => {
    const owner = await registerUser(app);
    const ownerKey = await withKeyPair(owner);
    const wsId = randomUUID();
    await owner.agent
      .post("/workspaces")
      .send({
        id: wsId,
        name: "Acme",
        protectedWorkspaceKey: await sealKey(
          ownerKey,
          generateKey(),
          sealContext.workspaceKey(wsId, owner.userId),
        ),
      })
      .expect(201);
    // The squatter registers the invitee's address first and never proves it.
    const squatter = await registerUser(app, "invitee@example.com", undefined, {
      verifyEmail: false,
    });
    await withKeyPair(squatter);
    await owner.agent
      .post(`/workspaces/${wsId}/members`)
      .send({ email: "invitee@example.com", role: "MEMBER" })
      .expect(201);
    expect((await squatter.agent.get("/workspaces/invitations").expect(200)).body).toEqual([]);
    const invite = await prisma.workspaceMember.findFirstOrThrow({
      where: { workspaceId: wsId, email: "invitee@example.com" },
    });
    const accept = await squatter.agent
      .post(`/workspaces/invitations/${invite.id}/accept`)
      .expect(403);
    expect(accept.body.code).toBe("EMAIL_NOT_VERIFIED");

    // Once the address is proven, the same account can join.
    await verify(verificationToken("invitee@example.com")).expect(204);
    const list = (await squatter.agent.get("/workspaces/invitations").expect(200)).body;
    expect(list).toHaveLength(1);
    await squatter.agent.post(`/workspaces/invitations/${invite.id}/accept`).expect(200);
  });

  it("confirm also refuses a member whose address is not verified", async () => {
    const owner = await registerUser(app);
    const ownerKey = await withKeyPair(owner);
    const wsId = randomUUID();
    const wsKey = generateKey();
    await owner.agent
      .post("/workspaces")
      .send({
        id: wsId,
        name: "Acme",
        protectedWorkspaceKey: await sealKey(
          ownerKey,
          wsKey,
          sealContext.workspaceKey(wsId, owner.userId),
        ),
      })
      .expect(201);
    const member = await registerUser(app);
    const memberKey = await withKeyPair(member);
    await owner.agent
      .post(`/workspaces/${wsId}/members`)
      .send({ email: member.email, role: "MEMBER" })
      .expect(201);
    const [invite] = (await member.agent.get("/workspaces/invitations").expect(200)).body;
    await member.agent.post(`/workspaces/invitations/${invite.id}/accept`).expect(200);
    // Simulates verification being withdrawn between accept and confirm.
    await prisma.user.update({ where: { id: member.userId }, data: { emailVerifiedAt: null } });
    const res = await owner.agent
      .post(`/workspaces/${wsId}/members/${invite.id}/confirm`)
      .send({
        protectedWorkspaceKey: await sealKey(
          memberKey,
          wsKey,
          sealContext.workspaceKey(wsId, member.userId),
        ),
      })
      .expect(403);
    expect(res.body.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("resending is limited and needs a session", async () => {
    await request(app.getHttpServer()).post("/auth/email/verify-request").set(WEB).expect(401);
    const user = await registerUser(app);
    // Already verified: nothing is sent.
    const res = await user.agent.post("/auth/email/verify-request").expect(200);
    expect(res.body.sent).toBe(false);
  });
});
