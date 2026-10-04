import { randomUUID } from "node:crypto";
import {
  decryptSharePayload,
  deriveShareKeys,
  encryptSharePayload,
  newShareLinkKey,
  randomBytes,
  sha256Hex,
  toBase64,
} from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { PrismaService } from "../src/common/prisma.service";
import { buildItem, createApp, registerUser, resetDb, type TestUser, WEB } from "./helpers";

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

const payload = {
  v: 1 as const,
  name: "GitHub",
  type: "LOGIN",
  fields: [{ label: "Password", value: "Shared-Secret-Value-9", sensitive: true }],
};

async function makeShare(
  opts: { maxViews?: number | null; passphrase?: string; expiresInMinutes?: number } = {},
) {
  const id = randomUUID();
  const link = newShareLinkKey();
  const salt = opts.passphrase ? toBase64(randomBytes(16)) : undefined;
  const keys = await deriveShareKeys(
    link,
    opts.passphrase && salt ? { value: opts.passphrase, salt } : undefined,
  );
  const ciphertext = await encryptSharePayload(keys.encKey, id, payload);
  const res = await user.agent
    .post("/shares")
    .send({
      id,
      label: "GitHub",
      ciphertext,
      expiresInMinutes: opts.expiresInMinutes ?? 60,
      maxViews: opts.maxViews === undefined ? 1 : opts.maxViews,
      includesTotp: false,
      ...(salt ? { passphraseSalt: salt, accessHash: await sha256Hex(keys.accessToken!) } : {}),
    })
    .expect(201);
  return { id, link, salt, keys, res };
}

const anon = () => request(app.getHttpServer());
const open = (id: string, body: object = {}) =>
  anon().post(`/public/shares/${id}/open`).set(WEB).send(body);

describe("share links", () => {
  it("a one-time link opens once, then its ciphertext is gone", async () => {
    const { id, keys } = await makeShare({ maxViews: 1 });
    const meta = await anon().get(`/public/shares/${id}`).set(WEB).expect(200);
    expect(meta.body).toMatchObject({ available: true, viewsLeft: 1, requiresPassphrase: false });

    const first = await open(id).expect(200);
    expect(await decryptSharePayload(keys.encKey, id, first.body.ciphertext)).toEqual(payload);
    await open(id).expect(404);
    const after = await anon().get(`/public/shares/${id}`).set(WEB).expect(200);
    expect(after.body).toMatchObject({ available: false, reason: "used" });
    expect((await prisma.share.findUniqueOrThrow({ where: { id } })).ciphertext).toBeNull();
  });

  it("only one of several simultaneous opens wins", async () => {
    const { id } = await makeShare({ maxViews: 1 });
    const results = await Promise.all(Array.from({ length: 5 }, () => open(id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it("counts views up to the limit", async () => {
    const { id } = await makeShare({ maxViews: 3 });
    expect((await open(id).expect(200)).body.viewsLeft).toBe(2);
    await open(id).expect(200);
    expect((await open(id).expect(200)).body.viewsLeft).toBe(0);
    await open(id).expect(404);
  });

  it("requires the passphrase, and closes after too many wrong ones", async () => {
    const { id, keys, link, salt } = await makeShare({ maxViews: null, passphrase: "blue horse" });
    await open(id).expect(403);
    const wrong = await deriveShareKeys(link, { value: "red horse", salt: salt! });
    await open(id, { accessToken: wrong.accessToken }).expect(403);
    const ok = await open(id, { accessToken: keys.accessToken }).expect(200);
    expect(await decryptSharePayload(keys.encKey, id, ok.body.ciphertext)).toEqual(payload);
    for (let i = 0; i < 10; i++) await open(id, { accessToken: wrong.accessToken });
    await open(id, { accessToken: keys.accessToken }).expect(404);
  });

  it("expired and revoked links give nothing", async () => {
    const a = await makeShare();
    await prisma.share.update({
      where: { id: a.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await open(a.id).expect(404);

    const b = await makeShare();
    await user.agent.delete(`/shares/${b.id}`).expect(204);
    await open(b.id).expect(404);
    expect((await prisma.share.findUniqueOrThrow({ where: { id: b.id } })).ciphertext).toBeNull();
  });

  it("refuses plaintext and keeps the server unable to read shares", async () => {
    await user.agent
      .post("/shares")
      .send({
        id: randomUUID(),
        label: "x",
        ciphertext: "Shared-Secret-Value-9",
        expiresInMinutes: 60,
        maxViews: 1,
        includesTotp: false,
      })
      .expect(400);
    await makeShare();
    const rows = JSON.stringify(await prisma.share.findMany());
    expect(rows).not.toContain("Shared-Secret-Value-9");
  });

  it("only the owner can list or revoke, and views show in the owner's activity", async () => {
    const item = await buildItem(user, "LOGIN", "GitHub", { username: "octo", password: "x" });
    await user.agent.post("/vault/items").send(item).expect(201);
    const { id } = await makeShare();
    const other = await registerUser(app);
    expect((await other.agent.get("/shares").expect(200)).body).toHaveLength(0);
    await other.agent.delete(`/shares/${id}`).expect(404);
    await open(id).expect(200);
    const list = (await user.agent.get("/shares").expect(200)).body;
    expect(list[0]).toMatchObject({ id, status: "used", viewCount: 1 });
    const actions = (await prisma.activityLog.findMany({ where: { userId: user.userId } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["share.created", "share.viewed"]));
  });
});
