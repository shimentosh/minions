import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { AiService } from "../src/ai/ai.module";
import { DeepSeekClient, UnsafeAiPayloadError } from "../src/ai/deepseek.client";
import type { PrismaService } from "../src/common/prisma.service";
import { resetConfig } from "../src/config";
import { buildItem, createApp, registerUser, resetDb, type TestUser } from "./helpers";

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

describe("security center", () => {
  it("finds weak, reused and duplicate credentials and explains the score", async () => {
    const reused = "Shared-Password-2024!";
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(user, "LOGIN", "Site A", {
          url: "https://a.example.com",
          username: "me",
          password: reused,
        }),
      )
      .expect(201);
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(user, "LOGIN", "Site B", {
          url: "https://b.other.com",
          username: "me",
          password: reused,
        }),
      )
      .expect(201);
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(user, "LOGIN", "Weak", {
          url: "https://weak.com",
          username: "me",
          password: "password",
        }),
      )
      .expect(201);
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(user, "LOGIN", "Weak copy", {
          url: "https://www.weak.com/login",
          username: "me",
          password: "abc",
        }),
      )
      .expect(201);
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(user, "LOGIN", "GitHub", {
          url: "https://github.com",
          username: "octo",
          password: "x8$Kp2!vQz#9Lm4@Wn7",
        }),
      )
      .expect(201);

    const res = await user.agent.get("/security/findings").expect(200);
    const types = res.body.findings.map((f: { type: string }) => f.type);
    expect(types).toEqual(
      expect.arrayContaining(["reused_password", "weak_password", "duplicate", "missing_2fa"]),
    );
    expect(res.body.counts.reused_password).toBe(2);
    expect(res.body.counts.weak_password).toBe(2);
    expect(res.body.score).toBeGreaterThan(0);
    expect(res.body.score).toBeLessThan(100);
    expect(res.body.factors.find((f: { label: string }) => f.label === "Unique passwords").ok).toBe(
      false,
    );
  });

  it("2FA saved as a separate authenticator item counts", async () => {
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(user, "LOGIN", "GitHub", {
          url: "https://github.com",
          username: "octo",
          password: "x8$Kp2!vQz#9Lm4@Wn7",
        }),
      )
      .expect(201);
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(user, "TOTP", "GitHub 2FA", {
          issuer: "GitHub",
          account: "octo",
          totp: "JBSWY3DPEHPK3PXP",
        }),
      )
      .expect(201);
    const res = await user.agent.get("/security/findings").expect(200);
    expect(res.body.findings.some((f: { type: string }) => f.type === "missing_2fa")).toBe(false);
  });

  it("flags expiring keys and long-unused items", async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(user, "API_KEY", "Stripe", {
          provider: "Stripe",
          api_key: "sk",
          expires_at: soon,
        }),
      )
      .expect(201);
    const old = await buildItem(user, "SECURE_NOTE", "Old note", { content: "x" });
    await user.agent.post("/vault/items").send(old).expect(201);
    await prisma.vaultItem.update({
      where: { id: old.id },
      data: { createdAt: new Date(Date.now() - 200 * 86_400_000) },
    });
    const res = await user.agent.get("/security/findings").expect(200);
    expect(res.body.counts.expiring).toBe(1);
    expect(res.body.counts.unused).toBe(1);
  });
});

describe("duplicates: merge, link, keep separate", () => {
  async function twoDupes() {
    const a = await buildItem(user, "LOGIN", "Google", {
      url: "https://accounts.google.com",
      username: "me@gmail.com",
      password: "pw-one-1234",
    });
    const b = await buildItem(user, "LOGIN", "Gmail", {
      url: "https://mail.google.com",
      username: "me@gmail.com",
      password: "pw-one-1234",
    });
    await user.agent.post("/vault/items").send(a).expect(201);
    await user.agent.post("/vault/items").send(b).expect(201);
    return { a, b };
  }

  it("detects the duplicate", async () => {
    await twoDupes();
    const res = await user.agent.get("/security/findings").expect(200);
    expect(res.body.findings.filter((f: { type: string }) => f.type === "duplicate")).toHaveLength(
      1,
    );
  });

  it("does not flag different accounts on the same site (no false positive)", async () => {
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(user, "LOGIN", "Personal", {
          url: "https://github.com",
          username: "me",
          password: "a-Strong-pw-111",
        }),
      )
      .expect(201);
    await user.agent
      .post("/vault/items")
      .send(
        await buildItem(user, "LOGIN", "Work", {
          url: "https://github.com",
          username: "me-work",
          password: "b-Strong-pw-222",
        }),
      )
      .expect(201);
    const res = await user.agent.get("/security/findings").expect(200);
    expect(res.body.findings.filter((f: { type: string }) => f.type === "duplicate")).toHaveLength(
      0,
    );
  });

  it("merge moves the source to the trash and its relations to the target", async () => {
    const { a, b } = await twoDupes();
    const youtube = await buildItem(user, "LOGIN", "YouTube", {
      url: "https://youtube.com",
      username: "x",
    });
    await user.agent.post("/vault/items").send(youtube).expect(201);
    await user.agent
      .post("/relations")
      .send({ fromItemId: b.id, toItemId: youtube.id, kind: "USED_FOR" })
      .expect(201);
    await user.agent
      .post(`/vault/items/${a.id}/merge`)
      .send({ sourceIds: [b.id] })
      .expect(200);
    const target = await user.agent.get(`/vault/items/${a.id}`).expect(200);
    expect(target.body.relations.map((r: { item: { name: string } }) => r.item.name)).toEqual([
      "YouTube",
    ]);
    const source = await user.agent.get(`/vault/items/${b.id}`).expect(200);
    expect(source.body.deletedAt).not.toBeNull();
  });

  it("link keeps both and relates them; keep-separate silences the finding", async () => {
    const { a, b } = await twoDupes();
    await user.agent
      .post("/relations")
      .send({ fromItemId: a.id, toItemId: b.id, kind: "USED_FOR" })
      .expect(201);
    const got = await user.agent.get(`/vault/items/${b.id}`).expect(200);
    expect(got.body.relations[0]).toMatchObject({ kind: "USED_FOR", direction: "incoming" });

    const finding = (await user.agent.get("/security/findings").expect(200)).body.findings.find(
      (f: { type: string }) => f.type === "duplicate",
    );
    await user.agent
      .post("/security/findings/state")
      .send({ key: finding.key, status: "keep_separate" })
      .expect(204);
    const after = (await user.agent.get("/security/findings").expect(200)).body;
    expect(after.findings.find((f: { key: string }) => f.key === finding.key).dismissed).toBe(true);
    expect(after.counts.duplicate).toBeUndefined();
  });
});

describe("AI classification never leaks secrets", () => {
  const realFetch = globalThis.fetch;
  let sent: string[] = [];

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    resetConfig();
    sent = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  type: "API_KEY",
                  provider: "Cloudflare",
                  project: "ClipMesh",
                  collection: "Infrastructure",
                  environment: "Production",
                  tags: ["api", "infrastructure"],
                  confidence: 0.99,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.DEEPSEEK_API_KEY;
    resetConfig();
  });

  it("sends only sanitised metadata, caps AI confidence below auto-apply", async () => {
    await user.agent.post("/projects").send({ name: "ClipMesh" }).expect(201);
    const res = await user.agent
      .post("/ai/classify")
      .send({
        text: "misc thing for clipmesh sk_live_51Habcdefghijklmnopqrstu 4111 1111 1111 1111 pw: hunter2!",
        name: "thing",
      })
      .expect(200);
    expect(sent).toHaveLength(1);
    const body = sent[0]!;
    for (const secret of ["sk_live", "4111", "hunter2"]) expect(body).not.toContain(secret);
    expect(res.body.classification.confidence).toBeLessThan(0.85);
    const logged = await prisma.aiClassification.findMany();
    expect(JSON.stringify(logged)).not.toMatch(/sk_live|4111|hunter2/);
  });

  it("never calls the AI for financial items", async () => {
    await user.agent
      .post("/ai/classify")
      .send({ name: "my card", typeHint: "CREDIT_CARD" })
      .expect(200);
    await user.agent
      .post("/ai/classify")
      .send({ name: "bank stuff", typeHint: "BANK_ACCOUNT" })
      .expect(200);
    expect(sent).toHaveLength(0);
  });

  it("skips the AI when the rules are already confident", async () => {
    const res = await user.agent
      .post("/ai/classify")
      .send({ name: "GitHub login", host: "github.com" })
      .expect(200);
    expect(sent).toHaveLength(0);
    expect(res.body.classification).toMatchObject({ type: "LOGIN", provider: "GitHub" });
  });

  it("respects the user's AI opt-out", async () => {
    await user.agent.patch("/users/me/settings").send({ aiEnabled: false }).expect(200);
    await user.agent.post("/ai/classify").send({ text: "some thing for later" }).expect(200);
    expect(sent).toHaveLength(0);
  });

  it("the client refuses a payload that still contains a secret", () => {
    const client = new DeepSeekClient();
    expect(() =>
      client.assertSafe(client.buildBody("sys", { text: "AKIAABCDEFGHIJKLMNOP" })),
    ).toThrow(UnsafeAiPayloadError);
    expect(() =>
      client.assertSafe(client.buildBody("sys", { text: "account 1234567890123" })),
    ).toThrow(UnsafeAiPayloadError);
    expect(() =>
      client.assertSafe(client.buildBody("sys", { text: "Cloudflare token for ClipMesh" })),
    ).not.toThrow();
  });

  it("drops invented projects and invalid types from the AI answer", () => {
    const svc = app.get(AiService);
    expect(svc.parse({ type: "NOT_A_TYPE" }, [])).toBeNull();
    const parsed = svc.parse(
      { type: "LOGIN", project: "Invented", tags: ["ok", "Bad Tag!"], confidence: 5 },
      ["Real"],
    );
    expect(parsed).toMatchObject({
      type: "LOGIN",
      project: undefined,
      tags: ["ok"],
      confidence: 0.84,
    });
  });
});

describe("learning from corrections", () => {
  it("applies a learned collection on the next similar item", async () => {
    for (let i = 0; i < 2; i++) {
      await user.agent
        .post("/ai/feedback")
        .send({
          provider: "Cloudflare",
          type: "CLOUD",
          collection: "Servers",
          outcome: "corrected",
        })
        .expect(204);
    }
    const res = await user.agent
      .post("/ai/classify")
      .send({ name: "Cloudflare DNS token", provider: "Cloudflare" })
      .expect(200);
    expect(res.body.classification).toMatchObject({ collection: "Servers", source: "preferences" });
    const prefs = await prisma.userClassificationPreference.findMany({
      where: { userId: user.userId },
    });
    expect(prefs.length).toBeGreaterThan(0);
  });
});

describe("imports", () => {
  it("imports encrypted batches and records outcomes without content", async () => {
    const job = (
      await user.agent
        .post("/imports")
        .send({ source: "notion", totalRecords: 2, duplicateCount: 0, invalidCount: 0 })
        .expect(201)
    ).body;
    const good = await buildItem(user, "LOGIN", "Imported", {
      username: "me",
      password: "imported-pw-1",
    });
    const bad = {
      id: randomUUID(),
      type: "LOGIN",
      name: "Bad",
      fields: [{ key: "password", value: "plaintext-import-pw", sensitive: true }],
    };
    const res = await user.agent
      .post(`/imports/${job.id}/items`)
      .send({
        entries: [
          { sourceRow: 2, item: good },
          { sourceRow: 3, item: bad },
        ],
      })
      .expect(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.failed).toHaveLength(1);
    await user.agent.post(`/imports/${job.id}/complete`).send({ skippedCount: 0 }).expect(200);
    const rows = await prisma.importItem.findMany({ where: { jobId: job.id } });
    expect(JSON.stringify(rows)).not.toContain("plaintext-import-pw");
  });
});

describe("dashboard", () => {
  it("summarises favorites, recent use and what changed", async () => {
    const fav = await buildItem(
      user,
      "LOGIN",
      "GitHub",
      { url: "https://github.com", username: "octo", password: "x8$Kp2!vQz#9Lm4@Wn7" },
      { favorite: true },
    );
    await user.agent.post("/vault/items").send(fav).expect(201);
    await user.agent
      .post(`/vault/items/${fav.id}/usage`)
      .send({ action: "item.copied", field: "password" })
      .expect(204);
    await prisma.user.update({
      where: { id: user.userId },
      data: { previousVisitAt: new Date(Date.now() - 86_400_000) },
    });
    const res = await user.agent.get("/dashboard").expect(200);
    expect(res.body.favorites.map((i: { name: string }) => i.name)).toEqual(["GitHub"]);
    expect(res.body.recent.map((i: { name: string }) => i.name)).toEqual(["GitHub"]);
    expect(res.body.sinceLastVisit.created).toBe(1);
    expect(res.body.activity.length).toBeGreaterThan(0);
  });
});
