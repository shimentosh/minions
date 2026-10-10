/**
 * "Sign in with the Minions app": an unlocked web session opens a session for
 * the browser extension. Only the web app's own cookie session may do it.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { PrismaService } from "../src/common/prisma.service";
import { createApp, login, registerUser, resetDb } from "./helpers";

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

const extensionDevice = () => ({
  clientDeviceId: randomUUID(),
  name: "Chrome extension on macOS",
  kind: "extension",
});

const bearer = (token: string) => ({
  "x-minions-client": "extension",
  authorization: `Bearer ${token}`,
});

describe("extension link", () => {
  it("gives the extension its own unlocked session on its own device", async () => {
    const user = await registerUser(app);
    const device = extensionDevice();
    const res = await user.agent.post("/vault/extension-link").send({ device }).expect(200);
    const token = res.body.token as string;
    expect(token).toBeTruthy();

    const me = await request(app.getHttpServer()).get("/auth/me").set(bearer(token)).expect(200);
    expect(me.body.user.id).toBe(user.userId);
    expect(me.body.session.vaultUnlocked).toBe(true);
    // Unlocked server-side, so the extension can read ciphertext straight away.
    await request(app.getHttpServer()).get("/vault/items").set(bearer(token)).expect(200);

    const row = await prisma.device.findFirstOrThrow({
      where: { userId: user.userId, clientDeviceId: device.clientDeviceId },
    });
    expect(row.kind).toBe("EXTENSION");
    const logged = await prisma.activityLog.findFirst({
      where: { userId: user.userId, action: "device.linked" },
    });
    expect(logged).not.toBeNull();
  });

  it("is refused while the web vault is locked", async () => {
    const user = await registerUser(app);
    await user.agent.post("/vault/lock").expect(204);
    const res = await user.agent
      .post("/vault/extension-link")
      .send({ device: extensionDevice() })
      .expect(403);
    expect(res.body.code).toBe("VAULT_LOCKED");
  });

  it("cannot be called with a bearer token, so a linked extension cannot mint more sessions", async () => {
    const user = await registerUser(app);
    const first = await user.agent
      .post("/vault/extension-link")
      .send({ device: extensionDevice() })
      .expect(200);
    await request(app.getHttpServer())
      .post("/vault/extension-link")
      .set(bearer(first.body.token))
      .send({ device: extensionDevice() })
      .expect(403);
  });

  it("only links extension devices", async () => {
    const user = await registerUser(app);
    await user.agent
      .post("/vault/extension-link")
      .send({ device: { ...extensionDevice(), kind: "web" } })
      .expect(400);
  });

  it("ends when the web app locks every device", async () => {
    const user = await registerUser(app);
    const { agent } = await login(app, user);
    const res = await agent
      .post("/vault/extension-link")
      .send({ device: extensionDevice() })
      .expect(200);
    await agent.post("/vault/emergency-lock").expect(200);
    await request(app.getHttpServer()).get("/auth/me").set(bearer(res.body.token)).expect(401);
  });
});
