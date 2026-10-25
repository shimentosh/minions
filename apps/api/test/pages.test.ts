/**
 * Notion-style pages: a tree of ciphertext. Titles, content and files are
 * encrypted under a per-page key wrapped by the vault key; the server refuses
 * plaintext, keeps every page in its owner's vault, keeps the tree acyclic,
 * trashes and restores sub-trees as one group, and re-wraps page keys in a
 * vault-key rotation.
 */
import { randomUUID } from "node:crypto";
import {
  aad,
  decryptBlob,
  decryptString,
  deriveMasterKeys,
  encryptBlob,
  encryptString,
  generateKey,
  pageAad,
  unwrapKey,
  wrapKey,
} from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import type { PrismaService } from "../src/common/prisma.service";
import { createApp, registerUser, resetDb, type TestUser } from "./helpers";

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

type Key = Uint8Array<ArrayBuffer>;

/** A page exactly as the web client builds it (apps/web/src/lib/pages/crypto.ts). */
async function buildPage(
  user: TestUser,
  title: string,
  opts: { parentId?: string | null; position?: string; body?: string; id?: string } = {},
) {
  const id = opts.id ?? randomUUID();
  const pageKey = generateKey();
  return {
    pageKey,
    body: {
      id,
      parentId: opts.parentId ?? null,
      position: opts.position ?? "a0",
      kind: "page",
      protectedKey: await wrapKey(user.vaultKey, pageKey, pageAad.key(user.vaultId, id)),
      metaEnc: await encryptString(pageKey, JSON.stringify({ title }), pageAad.meta(id)),
      contentEnc: opts.body
        ? await encryptString(
            pageKey,
            JSON.stringify({
              v: 1,
              doc: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: opts.body }] }],
              },
            }),
            pageAad.content(id),
          )
        : null,
    },
  };
}

async function create(user: TestUser, title: string, opts: Parameters<typeof buildPage>[2] = {}) {
  const p = await buildPage(user, title, opts);
  await user.agent.post("/pages").send(p.body).expect(201);
  return { id: p.body.id, pageKey: p.pageKey };
}

async function titleOf(
  vaultKey: Key,
  vaultId: string,
  page: { id: string; protectedKey: string; metaEnc: string },
) {
  const pageKey = await unwrapKey(vaultKey, page.protectedKey, pageAad.key(vaultId, page.id));
  return JSON.parse(await decryptString(pageKey, page.metaEnc, pageAad.meta(page.id))).title;
}

describe("pages", () => {
  it("round-trips an encrypted page tree and stores no plaintext", async () => {
    const alice = await registerUser(app);
    const root = await create(alice, "Company handbook", { body: "Our wifi is Hunter2Wifi" });
    const child = await create(alice, "Onboarding checklist", { parentId: root.id });

    const tree = (await alice.agent.get("/pages").expect(200)).body.pages;
    expect(tree).toHaveLength(2);
    const titles = await Promise.all(
      tree.map((p: never) => titleOf(alice.vaultKey, alice.vaultId, p)),
    );
    expect(titles.sort()).toEqual(["Company handbook", "Onboarding checklist"]);
    expect(tree.find((p: { id: string }) => p.id === child.id).parentId).toBe(root.id);

    const detail = (await alice.agent.get(`/pages/${root.id}`).expect(200)).body;
    const doc = JSON.parse(
      await decryptString(root.pageKey, detail.contentEnc, pageAad.content(root.id)),
    );
    expect(doc.doc.content[0].content[0].text).toBe("Our wifi is Hunter2Wifi");

    // Nothing anyone wrote is readable in the database.
    const dump = JSON.stringify(await prisma.page.findMany());
    for (const s of ["Company handbook", "Onboarding", "Hunter2Wifi"])
      expect(dump).not.toContain(s);
  });

  it("refuses plaintext titles, content and keys", async () => {
    const alice = await registerUser(app);
    const ok = (await buildPage(alice, "x")).body;
    for (const bad of [
      { ...ok, id: randomUUID(), metaEnc: '{"title":"Plain title"}' },
      { ...ok, id: randomUUID(), contentEnc: "plain body" },
      { ...ok, id: randomUUID(), protectedKey: "not-a-key" },
    ]) {
      const res = await alice.agent.post("/pages").send(bad);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("PLAINTEXT_SECRET");
      expect(JSON.stringify(res.body)).not.toContain("Plain title");
    }
    const page = await create(alice, "Real");
    const res = await alice.agent
      .put(`/pages/${page.id}`)
      .send({ metaEnc: ok.metaEnc, contentEnc: "<p>plain</p>" });
    expect(res.body.code).toBe("PLAINTEXT_SECRET");
  });

  it("keeps every page in its owner's vault", async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const page = await create(alice, "Alice only");
    const meta = (await buildPage(bob, "x")).body.metaEnc;

    await bob.agent.get(`/pages/${page.id}`).expect(404);
    await bob.agent.put(`/pages/${page.id}`).send({ metaEnc: meta }).expect(404);
    await bob.agent.patch(`/pages/${page.id}`).send({ favorite: true }).expect(404);
    await bob.agent.delete(`/pages/${page.id}`).expect(404);
    await bob.agent.get(`/pages/${page.id}/versions`).expect(404);
    expect((await bob.agent.get("/pages").expect(200)).body.pages).toHaveLength(0);

    // Bob cannot hang a page under Alice's, reuse her id, or move his under hers.
    const under = await buildPage(bob, "sneaky", { parentId: page.id });
    await bob.agent.post("/pages").send(under.body).expect(400);
    const reuse = await buildPage(bob, "same id", { id: page.id });
    await bob.agent
      .post("/pages/batch")
      .send({ pages: [reuse.body] })
      .expect(409);
    const own = await create(bob, "Bob's");
    await bob.agent.patch(`/pages/${own.id}`).send({ parentId: page.id }).expect(400);
    // And a smuggled vault id is rejected outright.
    await bob.agent
      .post("/pages")
      .send({ ...(await buildPage(bob, "y")).body, vaultId: alice.vaultId })
      .expect(400);
  });

  it("hands out encrypted bodies for the search index, owner's live pages only", async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const a = await create(alice, "A", { body: "deploy notes" });
    const empty = await create(alice, "Empty");
    const trashed = await create(alice, "Trashed", { body: "gone" });
    await alice.agent.delete(`/pages/${trashed.id}`).expect(204);

    const res = (
      await alice.agent
        .post("/pages/contents")
        .send({ ids: [a.id, empty.id, trashed.id, randomUUID()] })
        .expect(200)
    ).body;
    expect(res.rest).toEqual([]);
    expect(res.pages.map((p: { id: string }) => p.id).sort()).toEqual([a.id, empty.id].sort());
    const body = res.pages.find((p: { id: string }) => p.id === a.id);
    expect(body.revision).toBe(1);
    expect(body.contentEnc).not.toContain("deploy");
    const text = await decryptString(a.pageKey, body.contentEnc, pageAad.content(a.id));
    expect(text).toContain("deploy notes");

    // Someone else's ids return nothing.
    const other = (
      await bob.agent
        .post("/pages/contents")
        .send({ ids: [a.id] })
        .expect(200)
    ).body;
    expect(other).toEqual({ pages: [], rest: [] });
    await alice.agent.post("/pages/contents").send({ ids: [] }).expect(400);
    await alice.agent
      .post("/pages/contents")
      .send({ ids: ["nope"] })
      .expect(400);

    // Large bodies are split over several requests, at least one page each time.
    const big = "x".repeat(1_350_000);
    const bigs = [];
    for (const t of ["B1", "B2", "B3"]) bigs.push(await create(alice, t, { body: big }));
    const first = (
      await alice.agent
        .post("/pages/contents")
        .send({ ids: bigs.map((b) => b.id) })
        .expect(200)
    ).body;
    expect(first.pages).toHaveLength(2);
    expect(first.rest).toEqual([bigs[2]!.id]);
  });

  it("moves pages without ever making a cycle", async () => {
    const alice = await registerUser(app);
    const a = await create(alice, "A");
    const b = await create(alice, "B", { parentId: a.id });
    const c = await create(alice, "C", { parentId: b.id });

    await alice.agent.patch(`/pages/${a.id}`).send({ parentId: c.id }).expect(400);
    await alice.agent.patch(`/pages/${a.id}`).send({ parentId: a.id }).expect(400);
    const moved = (
      await alice.agent.patch(`/pages/${c.id}`).send({ parentId: null, position: "Zz" }).expect(200)
    ).body;
    expect(moved.parentId).toBeNull();
    expect(moved.position).toBe("Zz");
    await alice.agent.patch(`/pages/${a.id}`).send({ parentId: c.id }).expect(200);
  });

  it("trashes and restores a sub-tree as one group", async () => {
    const alice = await registerUser(app);
    const root = await create(alice, "Root");
    const child = await create(alice, "Child", { parentId: root.id });
    const grandchild = await create(alice, "Grandchild", { parentId: child.id });
    const sibling = await create(alice, "Sibling", { parentId: root.id });

    // The sibling was trashed on its own first: it stays in the trash later.
    await alice.agent.delete(`/pages/${sibling.id}`).expect(204);
    await alice.agent.delete(`/pages/${root.id}`).expect(204);
    expect((await alice.agent.get("/pages").expect(200)).body.pages).toHaveLength(0);
    expect((await alice.agent.get("/pages?view=trash").expect(200)).body.pages).toHaveLength(4);

    // A trashed page cannot be edited, take children, or be emptied while live.
    await alice.agent
      .post("/pages")
      .send((await buildPage(alice, "x", { parentId: root.id })).body)
      .expect(400);
    await alice.agent.post(`/pages/${root.id}/restore`).expect(204);
    const live = (await alice.agent.get("/pages").expect(200)).body.pages.map(
      (p: { id: string }) => p.id,
    );
    expect(live.sort()).toEqual([root.id, child.id, grandchild.id].sort());

    // Restoring a page whose parent is gone brings it back at the top level.
    await alice.agent.delete(`/pages/${child.id}`).expect(204);
    await alice.agent.delete(`/pages/${root.id}`).expect(204);
    await alice.agent.post(`/pages/${child.id}/restore`).expect(204);
    const back = (await alice.agent.get(`/pages/${child.id}`).expect(200)).body;
    expect(back.parentId).toBeNull();
    expect(back.deletedAt).toBeNull();

    await alice.agent.delete(`/pages/${child.id}/purge`).expect(400);
    await alice.agent.delete(`/pages/${root.id}/purge`).expect(204);
    await alice.agent.get(`/pages/${root.id}`).expect(404);
    expect(await prisma.page.count({ where: { id: sibling.id } })).toBe(0);
  });

  it("detects conflicting edits and keeps history", async () => {
    const alice = await registerUser(app);
    const page = await create(alice, "Draft");
    const v2 = await buildPage(alice, "Final", { id: page.id, body: "hello" });
    // Same page key as stored: re-encrypt with it.
    const metaEnc = await encryptString(
      page.pageKey,
      JSON.stringify({ title: "Final" }),
      pageAad.meta(page.id),
    );
    const saved = (
      await alice.agent
        .put(`/pages/${page.id}`)
        .send({ metaEnc, contentEnc: null, revision: 1 })
        .expect(200)
    ).body;
    expect(saved.revision).toBe(2);
    expect(await titleOf(alice.vaultKey, alice.vaultId, saved)).toBe("Final");
    const stale = await alice.agent
      .put(`/pages/${page.id}`)
      .send({ metaEnc: v2.body.metaEnc, revision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("REVISION_CONFLICT");

    const versions = (await alice.agent.get(`/pages/${page.id}/versions`).expect(200)).body;
    expect(versions).toHaveLength(1);
    expect(
      JSON.parse(await decryptString(page.pageKey, versions[0].metaEnc, pageAad.meta(page.id)))
        .title,
    ).toBe("Draft");
  });

  it("creates many pages at once, parents first, and retries safely", async () => {
    const alice = await registerUser(app);
    const top = await buildPage(alice, "Imported workspace");
    const kids = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        buildPage(alice, `Page ${i}`, { parentId: top.body.id, position: `a${i}` }),
      ),
    );
    const pages = [top.body, ...kids.map((k) => k.body)];
    const first = (await alice.agent.post("/pages/batch").send({ pages }).expect(200)).body;
    expect(first).toEqual({ created: 31, skipped: 0 });
    const again = (await alice.agent.post("/pages/batch").send({ pages }).expect(200)).body;
    expect(again).toEqual({ created: 0, skipped: 31 });

    // A parent that is neither stored nor earlier in the batch is refused.
    const orphan = await buildPage(alice, "Orphan", { parentId: randomUUID() });
    await alice.agent
      .post("/pages/batch")
      .send({ pages: [orphan.body] })
      .expect(400);
    expect(await prisma.page.count()).toBe(31);
  });

  it("stores files as ciphertext only", async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const page = await create(alice, "With a picture");
    const fileId = randomUUID();
    const bytes = new TextEncoder().encode("PNG-SECRET-BYTES ".repeat(100));
    const data = await encryptBlob(page.pageKey, bytes, pageAad.file(page.id, fileId));
    const metaEnc = await encryptString(
      page.pageKey,
      JSON.stringify({ name: "passport-scan.png", type: "image/png" }),
      pageAad.fileMeta(page.id, fileId),
    );
    const put = (path: string, agent = alice.agent, body: Uint8Array = data, meta = metaEnc) =>
      agent
        .put(path)
        .set("content-type", "application/octet-stream")
        .set("x-minions-file-meta", meta)
        .send(Buffer.from(body));

    await put(`/pages/${page.id}/files/${fileId}`).expect(204);
    await put(`/pages/${page.id}/files/${fileId}`).expect(204);
    const res = await alice.agent
      .get(`/pages/${page.id}/files/${fileId}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const plain = await decryptBlob(
      page.pageKey,
      new Uint8Array(res.body),
      pageAad.file(page.id, fileId),
    );
    expect(new TextDecoder().decode(plain)).toBe(new TextDecoder().decode(bytes));

    // Plaintext bytes or a plaintext name are refused; other people get nothing.
    const other = randomUUID();
    expect((await put(`/pages/${page.id}/files/${other}`, alice.agent, bytes)).body.code).toBe(
      "PLAINTEXT_SECRET",
    );
    expect(
      (await put(`/pages/${page.id}/files/${other}`, alice.agent, data, "passport-scan.png")).body
        .code,
    ).toBe("PLAINTEXT_SECRET");
    await put(`/pages/${page.id}/files/${randomUUID()}`, bob.agent).expect(404);
    await bob.agent.get(`/pages/${page.id}/files/${fileId}`).expect(404);

    const dump = Buffer.concat((await prisma.pageFile.findMany()).map((f) => Buffer.from(f.data)));
    expect(dump.includes(Buffer.from("PNG-SECRET-BYTES"))).toBe(false);
    expect(
      JSON.stringify(await prisma.pageFile.findMany({ select: { metaEnc: true } })),
    ).not.toContain("passport");
  });

  it("re-wraps page keys in a vault-key rotation", async () => {
    const alice = await registerUser(app);
    const page = await create(alice, "Survives rotation", { body: "still readable" });
    const keys = (await alice.agent.get("/vault/keys").expect(200)).body;
    const { stretchedKey } = await deriveMasterKeys(alice.password, keys.kdf);
    const userKey = await unwrapKey(stretchedKey, keys.protectedUserKey, aad.userKey(alice.userId));
    const fresh = generateKey();
    await alice.agent
      .post("/vault/rotation/start")
      .send({
        authKey: alice.authKey,
        protectedVaultKey: await wrapKey(userKey, fresh, aad.vaultKey(alice.vaultId)),
      })
      .expect(200);
    // New pages wait until the rotation is done.
    await alice.agent
      .post("/pages")
      .send((await buildPage(alice, "during")).body)
      .expect(409);

    expect((await alice.agent.get("/vault/rotation").expect(200)).body.remaining.pages).toBe(1);
    await alice.agent.post("/vault/rotation/finish").expect(409);

    const batch = (await alice.agent.get("/vault/rotation/batch?kind=pages").expect(200)).body;
    const pages = [];
    for (const row of batch.pages) {
      const context = pageAad.key(alice.vaultId, row.id);
      const pageKey = await unwrapKey(alice.vaultKey, row.protectedKey, context);
      pages.push({ id: row.id, protectedKey: await wrapKey(fresh, pageKey, context) });
    }
    // Plaintext in place of a wrapped key is refused.
    await alice.agent
      .post("/vault/rotation/batch")
      .send({ pages: [{ id: page.id, protectedKey: "plain" }] })
      .expect(400);
    await alice.agent.post("/vault/rotation/batch").send({ pages }).expect(200);
    await alice.agent.post("/vault/rotation/finish").expect(200);

    const after = (await alice.agent.get(`/pages/${page.id}`).expect(200)).body;
    expect(await titleOf(fresh, alice.vaultId, after)).toBe("Survives rotation");
    await expect(titleOf(alice.vaultKey, alice.vaultId, after)).rejects.toThrow();
  });

  it("includes pages in the encrypted backup", async () => {
    const alice = await registerUser(app);
    await create(alice, "Backed up", { body: "secret body" });
    const backup = (await alice.agent.get("/vault/export").expect(200)).body;
    expect(backup.pages).toHaveLength(1);
    expect(await titleOf(alice.vaultKey, alice.vaultId, backup.pages[0])).toBe("Backed up");
    expect(JSON.stringify(backup)).not.toContain("secret body");
  });
});
