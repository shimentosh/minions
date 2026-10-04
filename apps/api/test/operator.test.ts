import type { INestApplication } from "@nestjs/common";
import type { PrismaService } from "../src/common/prisma.service";
import { resetConfig } from "../src/config";
import { buildItem, createApp, registerUser, resetDb, type TestUser } from "./helpers";

/** The operator dashboard is for allowlisted accounts only, and holds no vault data. */

let app: INestApplication;
let prisma: PrismaService;
let operator: TestUser;
let user: TestUser;
const SECRET = "Operator-Must-Never-See-This-1!";

beforeAll(async () => {
  ({ app, prisma } = await createApp());
});
afterAll(async () => {
  delete process.env.OPERATOR_USER_IDS;
  resetConfig();
  await app.close();
});
beforeEach(async () => {
  await resetDb(prisma);
  operator = await registerUser(app, "ops@example.com");
  // The allowlist names account ids; the config is read again on each request.
  process.env.OPERATOR_USER_IDS = operator.userId.toUpperCase();
  resetConfig();
  user = await registerUser(app);
  const item = await buildItem(user, "LOGIN", "Private bank", {
    url: "https://bank.example",
    username: "someone",
    password: SECRET,
  });
  await user.agent.post("/vault/items").send(item).expect(201);
});

describe("operator dashboard", () => {
  it("does not exist for anyone outside the allowlist", async () => {
    await user.agent.get("/operator/overview").expect(404);
    await user.agent.get("/operator/users").expect(404);
    expect((await user.agent.get("/operator/status").expect(200)).body).toEqual({
      operator: false,
      needsTwoFactor: false,
    });
  });

  it("is keyed on account ids, so registering an operator's email gets nothing", async () => {
    // Email ownership is not verified: whoever registers an address first owns
    // that account. A second operator email with no account yet must not be claimable.
    process.env.OPERATOR_USER_IDS = `${operator.userId},`;
    resetConfig();
    const impostor = await registerUser(app, "new-operator@example.com");
    await prisma.user.update({ where: { id: impostor.userId }, data: { twoFactorEnabled: true } });
    await impostor.agent.get("/operator/overview").expect(404);
    await impostor.agent.get("/operator/users").expect(404);
    expect((await impostor.agent.get("/operator/status")).body.operator).toBe(false);
  });

  it("needs two-factor on the operator account outside development", async () => {
    const res = await operator.agent.get("/operator/overview");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OPERATOR_2FA_REQUIRED");
    expect((await operator.agent.get("/operator/status")).body.needsTwoFactor).toBe(true);
  });

  it("shows usage counts and accounts, never vault content, and logs each view", async () => {
    await prisma.user.update({ where: { id: operator.userId }, data: { twoFactorEnabled: true } });
    const overview = (await operator.agent.get("/operator/overview").expect(200)).body;
    expect(overview.users.total).toBe(2);
    expect(overview.users.new7d).toBe(2);
    expect(overview.items.total).toBe(1);
    expect(overview.items.byType).toEqual([{ type: "LOGIN", count: 1 }]);
    expect(overview.signupsByDay).toHaveLength(30);
    expect(overview.signupsByDay.at(-1).count).toBe(2);

    const users = (await operator.agent.get("/operator/users").query({ q: user.email }).expect(200))
      .body;
    expect(users.total).toBe(1);
    expect(users.items[0]).toMatchObject({ email: user.email, items: 1, twoFactor: false });

    const everything = JSON.stringify([overview, users]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("Private bank");
    expect(everything).not.toContain("bank.example");
    expect(everything).not.toMatch(/v1\.[A-Za-z0-9+/]{16}\./);

    const logged = await prisma.activityLog.count({
      where: { userId: operator.userId, action: "operator.viewed" },
    });
    expect(logged).toBe(2);
  });

  it("needs an unlocked vault", async () => {
    await prisma.user.update({ where: { id: operator.userId }, data: { twoFactorEnabled: true } });
    await operator.agent.post("/vault/lock").expect(204);
    expect((await operator.agent.get("/operator/overview")).body.code).toBe("VAULT_LOCKED");
  });
});
