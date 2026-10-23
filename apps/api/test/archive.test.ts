/**
 * Archived pages and vault items: hidden from lists by default, shown on
 * request, archived and brought back singly or in bulk, kept in backups.
 * Archiving is a plain timestamp; nothing encrypted changes.
 */
import { randomUUID } from "node:crypto";
import { encryptString, generateKey, pageAad, wrapKey } from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import type { PrismaService } from "../src/common/prisma.service";
import { buildItem, createApp, registerUser, resetDb, type TestUser } from "./helpers";

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

async function pageBody(
  user: TestUser,
  title: string,
  opts: { parentId?: string | null; archived?: boolean } = {},
) {
  const id = randomUUID();
  const pageKey = generateKey();
  return {
    id,
    parentId: opts.parentId ?? null,
    position: "a0",
    kind: "page",
    protectedKey: await wrapKey(user.vaultKey, pageKey, pageAad.key(user.vaultId, id)),
    metaEnc: await encryptString(pageKey, JSON.stringify({ title }), pageAad.meta(id)),
    ...(opts.archived ? { archived: true } : {}),
  };
}

const archivedIds = async (user: TestUser) =>
  new Set(
    (await user.agent.get("/pages").expect(200)).body.pages
      .filter((p: { archivedAt: string | null }) => p.archivedAt)
      .map((p: { id: string }) => p.id),
  );

describe("archived pages", () => {
  it("creates pages archived in a batch, as an import does", async () => {
    const alice = await registerUser(app);
    const root = await pageBody(alice, "Notion", { archived: true });
    const child = await pageBody(alice, "Child", { parentId: root.id, archived: true });
    const plain = await pageBody(alice, "Mine");
    await alice.agent
      .post("/pages/batch")
      .send({ pages: [root, child, plain] })
      .expect(200);
    expect(await archivedIds(alice)).toEqual(new Set([root.id, child.id]));
  });

  it("archives a sub-tree and brings a page back with the pages above it", async () => {
    const alice = await registerUser(app);
    const a = await pageBody(alice, "A");
    const b = await pageBody(alice, "B", { parentId: a.id });
    const c = await pageBody(alice, "C", { parentId: b.id });
    const other = await pageBody(alice, "Other");
    await alice.agent
      .post("/pages/batch")
      .send({ pages: [a, b, c, other] })
      .expect(200);

    const res = await alice.agent
      .post("/pages/archive")
      .send({ ids: [a.id], archived: true })
      .expect(200);
    expect(res.body.updated).toBe(3);
    expect(await archivedIds(alice)).toEqual(new Set([a.id, b.id, c.id]));

    // Bringing back C also brings back B and A (so C is reachable) but leaves nothing else.
    await alice.agent
      .post("/pages/archive")
      .send({ ids: [c.id], archived: false })
      .expect(200);
    expect(await archivedIds(alice)).toEqual(new Set());

    // Bulk.
    await alice.agent
      .post("/pages/archive")
      .send({ ids: [b.id, other.id], archived: true })
      .expect(200);
    expect(await archivedIds(alice)).toEqual(new Set([b.id, c.id, other.id]));
  });

  it("only touches the caller's live pages", async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mine = await pageBody(alice, "Mine");
    await alice.agent
      .post("/pages/batch")
      .send({ pages: [mine] })
      .expect(200);
    await bob.agent
      .post("/pages/archive")
      .send({ ids: [mine.id], archived: true })
      .expect(404);
    await alice.agent.delete(`/pages/${mine.id}`).expect(204);
    await alice.agent
      .post("/pages/archive")
      .send({ ids: [mine.id], archived: true })
      .expect(404);
    await alice.agent.post("/pages/archive").send({ ids: [], archived: true }).expect(400);
  });

  it("keeps the archived state in the encrypted backup", async () => {
    const alice = await registerUser(app);
    const p = await pageBody(alice, "Old", { archived: true });
    await alice.agent
      .post("/pages/batch")
      .send({ pages: [p] })
      .expect(200);
    const backup = (await alice.agent.get("/vault/export").expect(200)).body;
    expect(backup.pages[0].archivedAt).toBeTruthy();
  });
});

describe("archived vault items", () => {
  async function items(user: TestUser, query = "") {
    return (await user.agent.get(`/vault/items${query}`).expect(200)).body;
  }

  it("hides archived items from lists and search unless asked", async () => {
    const alice = await registerUser(app);
    const live = await buildItem(alice, "LOGIN", "GitHub", { username: "dev", password: "pw-1!" });
    const old = await buildItem(
      alice,
      "LOGIN",
      "GitHub old",
      { username: "old", password: "pw-2!" },
      { archived: true, tags: ["notion-import"] },
    );
    await alice.agent.post("/vault/items").send(live).expect(201);
    const created = (await alice.agent.post("/vault/items").send(old).expect(201)).body;
    expect(created.archivedAt).toBeTruthy();

    const def = await items(alice, "?q=github");
    expect(def.items.map((i: { id: string }) => i.id)).toEqual([live.id]);
    expect(def.hiddenArchived).toBe(1);
    expect((await items(alice, "?q=github&archived=include")).items).toHaveLength(2);
    const only = await items(alice, "?archived=only");
    expect(only.items.map((i: { id: string }) => i.id)).toEqual([old.id]);
    expect(only.hiddenArchived).toBeUndefined();
    // Tags still find it when archived ones are shown.
    expect((await items(alice, "?tag=notion-import&archived=include")).items).toHaveLength(1);
    // Opening an archived item still works.
    await alice.agent.get(`/vault/items/${old.id}`).expect(200);
  });

  it("archives and brings back items singly and in bulk", async () => {
    const alice = await registerUser(app);
    const ids: string[] = [];
    for (const name of ["One", "Two", "Three"]) {
      const it = await buildItem(alice, "SECURE_NOTE", name, { content: name });
      await alice.agent.post("/vault/items").send(it).expect(201);
      ids.push(it.id);
    }
    const one = (
      await alice.agent.patch(`/vault/items/${ids[0]}`).send({ archived: true }).expect(200)
    ).body;
    expect(one.archivedAt).toBeTruthy();
    await alice.agent
      .patch("/vault/items/bulk")
      .send({ ids: [ids[1], ids[2]], archived: true })
      .expect(200);
    expect((await items(alice)).items).toHaveLength(0);
    expect((await items(alice)).hiddenArchived).toBe(3);

    await alice.agent.patch("/vault/items/bulk").send({ ids, archived: false }).expect(200);
    expect((await items(alice)).items).toHaveLength(3);

    const bob = await registerUser(app);
    await bob.agent
      .patch("/vault/items/bulk")
      .send({ ids: [ids[0]], archived: true })
      .expect(404);
  });

  it("keeps archived items in the backup and off the dashboard", async () => {
    const alice = await registerUser(app);
    const it = await buildItem(
      alice,
      "LOGIN",
      "Old",
      { password: "pw-3!" },
      { archived: true, favorite: true },
    );
    await alice.agent.post("/vault/items").send(it).expect(201);
    const backup = (await alice.agent.get("/vault/export").expect(200)).body;
    expect(backup.items[0].archivedAt).toBeTruthy();
    const dash = (await alice.agent.get("/dashboard").expect(200)).body;
    expect(JSON.stringify(dash)).not.toContain(it.id);
  });
});
