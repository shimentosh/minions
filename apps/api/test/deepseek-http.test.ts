import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { PrismaService } from "../src/common/prisma.service";
import { resetConfig } from "../src/config";
import { createApp, registerUser, resetDb, type TestUser } from "./helpers";

// A stand-in for api.deepseek.com, over real HTTP: the same request the
// production client sends, received and inspected here.
let server: Server;
let received: {
  headers: IncomingMessage["headers"];
  path: string;
  body: Record<string, unknown>;
}[] = [];
let reply: (body: Record<string, unknown>) => { status: number; json: unknown };

let app: INestApplication;
let prisma: PrismaService;
let user: TestUser;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      received.push({ headers: req.headers, path: req.url ?? "", body });
      const r = reply(body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.DEEPSEEK_API_KEY = "sk-test-not-real";
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetConfig();
  ({ app, prisma } = await createApp());
});

afterAll(async () => {
  await app.close();
  server.close();
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
  resetConfig();
});

beforeEach(async () => {
  await resetDb(prisma);
  user = await registerUser(app);
  received = [];
  reply = () => ({
    status: 200,
    json: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              type: "CLOUD",
              provider: "Hetzner Cloud",
              project: "ClipMesh",
              collection: "Servers",
              environment: "Production",
              tags: ["infrastructure", "vps"],
              confidence: 0.91,
            }),
          },
        },
      ],
    },
  });
});

describe("DeepSeek over HTTP", () => {
  it("sends an OpenAI-style request with the key, sanitised content and JSON mode", async () => {
    await user.agent.post("/projects").send({ name: "ClipMesh" }).expect(201);
    const res = await user.agent
      .post("/ai/classify")
      .send({
        text: "thing for clipmesh box 4111 1111 1111 1111 pw: hunter2! AKIAABCDEFGHIJKLMNOP",
        name: "box",
      })
      .expect(200);

    expect(received).toHaveLength(1);
    const req = received[0]!;
    expect(req.path).toBe("/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-test-not-real");
    expect(req.body).toMatchObject({
      model: "deepseek-chat",
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const wire = JSON.stringify(req.body);
    for (const secret of ["4111", "hunter2", "AKIA"]) expect(wire).not.toContain(secret);
    expect(wire).toContain("ClipMesh");

    // The answer is used, confidence is capped below auto-apply, the project
    // is accepted because it exists.
    expect(res.body.classification).toMatchObject({
      type: "CLOUD",
      project: "ClipMesh",
      source: "ai",
    });
    expect(res.body.classification.confidence).toBeLessThan(0.85);
    const logged = await prisma.aiClassification.findFirstOrThrow({
      where: { userId: user.userId },
    });
    expect(logged.status).toBe("suggested");
  });

  it("falls back to the rules when DeepSeek errors or answers nonsense", async () => {
    reply = () => ({ status: 500, json: { error: "boom" } });
    const a = await user.agent.post("/ai/classify").send({ text: "misc thing" }).expect(200);
    expect(a.body.classification.source).toBe("rules");

    reply = () => ({ status: 200, json: { choices: [{ message: { content: "not json" } }] } });
    const b = await user.agent
      .post("/ai/classify")
      .send({ text: "another misc thing" })
      .expect(200);
    expect(b.body.classification.source).toBe("rules");
    expect(received).toHaveLength(2);
  });
});
