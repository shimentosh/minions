/**
 * Vault-key rotation: a new key replaces the old one and every secret in the
 * personal vault (fields, field history, note bodies, note history, password
 * fingerprints) moves to it. The server never sees either key, refuses
 * plaintext or missing secrets, blocks other writes meanwhile, and lets an
 * interrupted rotation resume.
 */
import { randomUUID } from "node:crypto";
import {
  aad,
  DecryptionError,
  decryptString,
  encryptString,
  generateKey,
  secretFingerprint,
  unwrapKey,
  wrapKey,
} from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import type TestAgent from "supertest/lib/agent";
import type { PrismaService } from "../src/common/prisma.service";
import {
  buildItem,
  createApp,
  login,
  registerUser,
  resetDb,
  type TestUser,
  vaultKeyFrom,
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

type Key = Uint8Array<ArrayBuffer>;

async function userKeyOf(user: TestUser, agent: TestAgent = user.agent) {
  const { deriveMasterKeys } = await import("@minions/core");
  const keys = (await agent.get("/vault/keys").expect(200)).body;
  const { stretchedKey } = await deriveMasterKeys(user.password, keys.kdf);
  return unwrapKey(stretchedKey, keys.protectedUserKey, aad.userKey(user.userId));
}

async function start(user: TestUser, fresh: Key) {
  const userKey = await userKeyOf(user);
  return user.agent.post("/vault/rotation/start").send({
    authKey: user.authKey,
    protectedVaultKey: await wrapKey(userKey, fresh, aad.vaultKey(user.vaultId)),
  });
}

/** What the web client does (apps/web/src/lib/key-rotation.ts), in test form. */
async function moveItems(agent: TestAgent, oldKey: Key, newKey: Key, limit = 50) {
  const page = (await agent.get(`/vault/rotation/batch?kind=items&limit=${limit}`).expect(200))
    .body;
  const items = [];
  for (const row of page.items) {
    let password: string | null = null;
    const fields = [];
    for (const f of row.fields) {
      const plain = await decryptString(oldKey, f.value, aad.field(row.id, f.key));
      if (f.key === "password") password = plain;
      fields.push({
        key: f.key,
        value: await encryptString(newKey, plain, aad.field(row.id, f.key)),
      });
    }
    const versions = [];
    for (const v of row.versions) {
      const vf = [];
      for (const f of v.fields) {
        const plain = await decryptString(oldKey, f.value, aad.version(row.id, f.key));
        vf.push({
          key: f.key,
          value: await encryptString(newKey, plain, aad.version(row.id, f.key)),
        });
      }
      versions.push({ id: v.id, fields: vf });
    }
    items.push({
      id: row.id,
      fields,
      versions,
      ...(row.hasPasswordFingerprint && password
        ? { passwordFingerprint: await secretFingerprint(newKey, password) }
        : {}),
    });
  }
  if (items.length) await agent.post("/vault/rotation/batch").send({ items }).expect(200);
  return items.length;
}

async function moveNotes(agent: TestAgent, oldKey: Key, newKey: Key) {
  const page = (await agent.get("/vault/rotation/batch?kind=notes").expect(200)).body;
  const notes = [];
  for (const row of page.notes) {
    const body = async (enc: string | null) =>
      enc
        ? encryptString(
            newKey,
            await decryptString(oldKey, enc, aad.note(row.id)),
            aad.note(row.id),
          )
        : null;
    const versions = [];
    for (const v of row.versions) versions.push({ id: v.id, contentEnc: await body(v.contentEnc) });
    notes.push({ id: row.id, contentEnc: await body(row.contentEnc), versions });
  }
  if (notes.length) await agent.post("/vault/rotation/batch").send({ notes }).expect(200);
  return notes.length;
}

async function seedVault(user: TestUser) {
  const login1 = await buildItem(user, "LOGIN", "GitHub", {
    url: "https://github.com",
    username: "octo",
    password: "first-Password-1",
  });
  await user.agent.post("/vault/items").send(login1).expect(201);
  // A second revision, so the old password sits in encrypted history.
  const login2 = await buildItem(
    user,
    "LOGIN",
    "GitHub",
    { url: "https://github.com", username: "octo", password: "second-Password-2" },
    { id: login1.id },
  );
  await user.agent.put(`/vault/items/${login1.id}`).send(login2).expect(200);
  const card = await buildItem(user, "CREDIT_CARD", "Visa", {
    number: "4111111111111111",
    cvv: "123",
  });
  await user.agent.post("/vault/items").send(card).expect(201);
  const noteId = randomUUID();
  await user.agent
    .post("/notes")
    .send({
      id: noteId,
      title: "Recovery",
      contentEnc: await encryptString(user.vaultKey, "<p>note body secret</p>", aad.note(noteId)),
    })
    .expect(201);
  await prisma.noteVersion.create({
    data: {
      noteId,
      revision: 1,
      title: "Recovery",
      contentEnc: await encryptString(user.vaultKey, "<p>older body</p>", aad.note(noteId)),
    },
  });
  return { loginId: login1.id, cardId: card.id, noteId };
}

const opens = async (key: Key, envelope: string, context: string) =>
  decryptString(key, envelope, context).then(
    () => true,
    (e) => {
      if (e instanceof DecryptionError) return false;
      throw e;
    },
  );

describe("vault key rotation", () => {
  it("moves every secret to the new key and swaps the wrapped key", async () => {
    const user = await registerUser(app);
    const { loginId, cardId, noteId } = await seedVault(user);
    const before = await prisma.vaultItem.findUniqueOrThrow({ where: { id: loginId } });
    const fresh = generateKey();
    const other = await login(app, user, { clientDeviceId: "other-device-01" });

    // The master password is required; a wrong one starts nothing.
    const bad = { ...user, authKey: Buffer.alloc(32, 9).toString("base64") };
    expect((await start(bad, fresh)).status).toBe(403);
    expect((await start(user, fresh)).status).toBe(200);
    expect((await start(user, generateKey())).status).toBe(409);

    // Meanwhile: other sessions are locked, writes and backups are refused.
    await other.agent.get("/vault/items").expect(403);
    await user.agent.patch(`/vault/items/${loginId}`).send({ favorite: true }).expect(409);
    await user.agent
      .post("/vault/items")
      .send(await buildItem(user, "LOGIN", "x", { username: "u" }))
      .expect(409);
    await user.agent.get("/vault/export").expect(409);
    await user.agent.post("/vault/heartbeat").expect(204);
    await user.agent.get("/vault/items").expect(200);
    await user.agent.post("/vault/rotation/finish").expect(409);

    expect(await moveItems(user.agent, user.vaultKey, fresh)).toBe(2);
    expect(await moveNotes(user.agent, user.vaultKey, fresh)).toBe(1);
    expect((await user.agent.post("/vault/rotation/finish").expect(200)).body.keyGen).toBe(2);

    // The vault key on the server is the new one, wrapped by the same user key.
    const userKey = await userKeyOf(user);
    const vault = await prisma.vault.findUniqueOrThrow({ where: { id: user.vaultId } });
    expect(vault.pendingProtectedKey).toBeNull();
    const unwrapped = await unwrapKey(userKey, vault.protectedKey, aad.vaultKey(user.vaultId));
    expect(Buffer.from(unwrapped).equals(Buffer.from(fresh))).toBe(true);

    // Every envelope opens with the new key and none with the old.
    const fields = await prisma.vaultItemField.findMany({
      where: { itemId: { in: [loginId, cardId] }, sensitive: true },
    });
    expect(fields.length).toBe(3);
    for (const f of fields) {
      expect(await opens(fresh, f.value, aad.field(f.itemId, f.key))).toBe(true);
      expect(await opens(user.vaultKey, f.value, aad.field(f.itemId, f.key))).toBe(false);
    }
    const version = await prisma.vaultItemVersion.findFirstOrThrow({ where: { itemId: loginId } });
    const old = (version.fields as { key: string; value: string; sensitive: boolean }[]).find(
      (f) => f.key === "password",
    )!;
    expect(await decryptString(fresh, old.value, aad.version(loginId, "password"))).toBe(
      "first-Password-1",
    );
    const note = await prisma.note.findUniqueOrThrow({
      where: { id: noteId },
      include: { versions: true },
    });
    expect(await decryptString(fresh, note.contentEnc!, aad.note(noteId))).toBe(
      "<p>note body secret</p>",
    );
    expect(await decryptString(fresh, note.versions[0]!.contentEnc!, aad.note(noteId))).toBe(
      "<p>older body</p>",
    );

    // The reuse fingerprint now follows the new key.
    const after = await prisma.vaultItem.findUniqueOrThrow({ where: { id: loginId } });
    expect(after.passwordFingerprint).not.toBe(before.passwordFingerprint);
    expect(after.passwordFingerprint).toBe(await secretFingerprint(fresh, "second-Password-2"));

    // Writes work again; the other device must unlock and gets the new key.
    await user.agent.patch(`/vault/items/${loginId}`).send({ favorite: true }).expect(200);
    const relog = await login(app, user, { clientDeviceId: "third-device-01" });
    const relogKey = await vaultKeyFrom(relog.stretchedKey, relog.res.body.keys);
    expect(Buffer.from(relogKey).equals(Buffer.from(fresh))).toBe(true);
    const events = await prisma.securityEvent.findMany({
      where: { userId: user.userId, type: { startsWith: "vault_key_rot" } },
    });
    expect(events.map((e) => e.type).sort()).toEqual([
      "vault_key_rotated",
      "vault_key_rotation_started",
    ]);
  });

  it("resumes after an interruption: the next sign-in carries the pending key", async () => {
    const user = await registerUser(app);
    await seedVault(user);
    const fresh = generateKey();
    expect((await start(user, fresh)).status).toBe(200);
    expect(await moveItems(user.agent, user.vaultKey, fresh, 1)).toBe(1);

    // The tab closed. A new sign-in gets both wrapped keys.
    const again = await login(app, user, { clientDeviceId: "resume-device-1" });
    const keys = again.res.body.keys;
    expect(keys.pendingProtectedVaultKey).toBeTruthy();
    const userKey = await unwrapKey(
      again.stretchedKey,
      keys.protectedUserKey,
      aad.userKey(user.userId),
    );
    const oldKey = await unwrapKey(userKey, keys.protectedVaultKey, aad.vaultKey(user.vaultId));
    const newKey = await unwrapKey(
      userKey,
      keys.pendingProtectedVaultKey,
      aad.vaultKey(user.vaultId),
    );
    expect(Buffer.from(newKey).equals(Buffer.from(fresh))).toBe(true);

    const status = (await again.agent.get("/vault/rotation").expect(200)).body;
    expect(status.remaining).toEqual({ items: 1, notes: 1 });
    // Re-sending an already moved item is a harmless no-op.
    expect(await moveItems(again.agent, oldKey, newKey)).toBe(1);
    await moveNotes(again.agent, oldKey, newKey);
    await again.agent.post("/vault/rotation/finish").expect(200);
    expect((await again.agent.get("/vault/rotation").expect(200)).body.inProgress).toBe(false);
  });

  it("refuses plaintext, missing secrets and other accounts' rows", async () => {
    const alice = await registerUser(app);
    const { loginId, cardId } = await seedVault(alice);
    const bob = await registerUser(app);
    const fresh = generateKey();
    expect((await start(alice, fresh)).status).toBe(200);
    const page = (await alice.agent.get("/vault/rotation/batch?kind=items").expect(200)).body;
    const card = page.items.find((i: { id: string }) => i.id === cardId);

    // Plaintext in place of a secret.
    await alice.agent
      .post("/vault/rotation/batch")
      .send({
        items: [
          {
            id: cardId,
            fields: card.fields.map((f: { key: string }) => ({
              key: f.key,
              value: "4111111111111111",
            })),
            versions: [],
          },
        ],
      })
      .expect(400);
    // A secret dropped.
    await alice.agent
      .post("/vault/rotation/batch")
      .send({ items: [{ id: cardId, fields: card.fields.slice(1), versions: [] }] })
      .expect(400);
    // A history entry left behind.
    const login1 = page.items.find((i: { id: string }) => i.id === loginId);
    await alice.agent
      .post("/vault/rotation/batch")
      .send({ items: [{ id: loginId, fields: login1.fields, versions: [] }] })
      .expect(400);
    const stored = await prisma.vaultItemField.findMany({ where: { itemId: cardId } });
    expect(stored.every((f) => !f.value.includes("4111111111111111"))).toBe(true);

    // Bob has no rotation, and cannot write into Alice's rows with his own.
    await bob.agent.get("/vault/rotation/batch?kind=items").expect(409);
    expect((await start(bob, generateKey())).status).toBe(200);
    await bob.agent
      .post("/vault/rotation/batch")
      .send({ items: [{ id: cardId, fields: card.fields, versions: [] }] })
      .expect(400);
    const bobPage = (await bob.agent.get("/vault/rotation/batch?kind=items").expect(200)).body;
    expect(bobPage.items).toHaveLength(0);
  });
});
