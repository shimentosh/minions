import { randomUUID } from "node:crypto";
import {
  aad,
  decryptString,
  encryptString,
  generateKey,
  generateUserKeyPair,
  type ItemKeyMaterial,
  importPrivateKey,
  keyAad,
  openSealedKey,
  type PendingSeal,
  type PeopleShare,
  protectPrivateKey,
  type SharedItemDetail,
  type SharedWithMeItem,
  sealContext,
  sealKey,
  unwrapKey,
  wrapKey,
} from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import type { PrismaService } from "../src/common/prisma.service";
import { testOutbox } from "../src/mail/mailer";
import { buildItem, createApp, registerUser, type TestUser } from "./helpers";

/**
 * Sharing personal items with people by email: the server stores only keys
 * it cannot open, enforces who may see and change what, and never lets an
 * unverified address receive anything.
 */

let app: INestApplication;
let prisma: PrismaService;

beforeAll(async () => {
  ({ app, prisma } = await createApp());
});
afterAll(async () => {
  await app.close();
});

const SECRET = "Shared-Secret-NEVER-IN-DB-7!";

interface Person extends TestUser {
  publicKey: string;
  privateKey: CryptoKey;
}

async function withKeys(user: TestUser): Promise<Person> {
  const pair = await generateUserKeyPair();
  await user.agent
    .post("/account/keypair")
    .send({
      publicKey: pair.publicKey,
      protectedPrivateKey: await protectPrivateKey(generateKey(), pair.privateKey, user.userId),
    })
    .expect(204);
  return {
    ...user,
    publicKey: pair.publicKey,
    privateKey: await importPrivateKey(pair.privateKey),
  };
}

async function person(email?: string) {
  return withKeys(await registerUser(app, email));
}

/** A login in the owner's vault, under the vault key, as the web client saves it. */
async function createLogin(owner: TestUser, name = "Netflix") {
  const item = await buildItem(owner, "LOGIN", name, {
    url: "https://netflix.com",
    username: "family@example.com",
    password: SECRET,
  });
  await owner.agent.post("/vault/items").send(item).expect(201);
  return item.id;
}

/** What the client does on first share: a new item key, everything re-encrypted under it. */
async function giveItemKey(owner: TestUser, itemId: string, from?: Uint8Array<ArrayBuffer>) {
  const m = (await owner.agent.get(`/vault/items/${itemId}/item-key`).expect(200))
    .body as ItemKeyMaterial & {
    holders: { shareId: string; userId: string; publicKey: string }[];
  };
  const old =
    from ??
    (m.protectedItemKey
      ? await unwrapKey(
          owner.vaultKey,
          m.protectedItemKey,
          keyAad.itemKeyForVault(owner.vaultId, itemId),
        )
      : owner.vaultKey);
  const next = generateKey();
  const move = async (v: string, ctx: string) =>
    encryptString(next, await decryptString(old, v, ctx), ctx);
  const body = {
    revision: m.revision,
    protectedItemKey: await wrapKey(
      owner.vaultKey,
      next,
      keyAad.itemKeyForVault(owner.vaultId, itemId),
    ),
    fields: await Promise.all(
      m.fields.map(async (f) => ({
        key: f.key,
        value: await move(f.value, aad.field(itemId, f.key)),
      })),
    ),
    versions: await Promise.all(
      m.versions.map(async (v) => ({
        id: v.id,
        fields: await Promise.all(
          v.fields.map(async (f) => ({
            key: f.key,
            value: await move(f.value, aad.version(itemId, f.key)),
          })),
        ),
      })),
    ),
    seals: await Promise.all(
      m.holders.map(async (h) => ({
        shareId: h.shareId,
        sealedItemKey: await sealKey(h.publicKey, next, sealContext.itemKey(itemId, h.userId)),
      })),
    ),
  };
  await owner.agent.post(`/vault/items/${itemId}/item-key`).send(body).expect(200);
  return next;
}

async function shareWith(
  owner: TestUser,
  itemId: string,
  itemKey: Uint8Array<ArrayBuffer>,
  email: string,
  opts: { permission?: "VIEW" | "EDIT"; expiresInMinutes?: number } = {},
) {
  const lookup = (await owner.agent.get("/people-shares/lookup").query({ email }).expect(200)).body;
  const res = await owner.agent
    .post(`/vault/items/${itemId}/people`)
    .send({
      email,
      permission: opts.permission ?? "VIEW",
      expiresInMinutes: opts.expiresInMinutes ?? 0,
      ...(lookup.recipient
        ? {
            recipientUserId: lookup.recipient.id,
            sealedItemKey: await sealKey(
              lookup.recipient.publicKey,
              itemKey,
              sealContext.itemKey(itemId, lookup.recipient.id),
            ),
          }
        : {}),
    })
    .expect(201);
  return res.body as PeopleShare;
}

async function openAsRecipient(r: Person, itemId: string) {
  const detail = (await r.agent.get(`/shared/items/${itemId}`).expect(200))
    .body as SharedItemDetail;
  const key = await openSealedKey(
    r.privateKey,
    detail.sealedItemKey,
    sealContext.itemKey(itemId, r.userId),
  );
  const pw = detail.fields.find((f) => f.key === "password")!;
  return {
    detail,
    key,
    password: await decryptString(key, pw.value, aad.field(itemId, "password")),
  };
}

describe("sharing an item with someone on Minions", () => {
  it("re-keys the item, seals it to them, and they can open it", async () => {
    const owner = await person();
    const friend = await person();
    const itemId = await createLogin(owner);

    // Not shareable while under the vault key.
    await owner.agent
      .post(`/vault/items/${itemId}/people`)
      .send({ email: friend.email, permission: "VIEW", expiresInMinutes: 0 })
      .expect(409);

    const itemKey = await giveItemKey(owner, itemId);
    const share = await shareWith(owner, itemId, itemKey, friend.email);
    expect(share.status).toBe("active");
    expect(share.recipient?.id).toBe(friend.userId);

    // The owner still opens it, through the wrapped item key.
    const mine = (await owner.agent.get(`/vault/items/${itemId}`).expect(200)).body;
    expect(mine.sharedWith).toBe(1);
    const k = await unwrapKey(
      owner.vaultKey,
      mine.protectedItemKey,
      keyAad.itemKeyForVault(owner.vaultId, itemId),
    );
    const pw = mine.fields.find((f: { key: string }) => f.key === "password");
    expect(await decryptString(k, pw.value, aad.field(itemId, "password"))).toBe(SECRET);

    const list = (await friend.agent.get("/shared").expect(200)).body as SharedWithMeItem[];
    expect(list).toHaveLength(1);
    expect(list[0]!.sharedBy.email).toBe(owner.email);
    expect(list[0]!.isNew).toBe(true);
    // The owner's organisation is not the recipient's business.
    expect(list[0]!.tags).toEqual([]);

    const opened = await openAsRecipient(friend, itemId);
    expect(opened.password).toBe(SECRET);
    expect(opened.detail.versionCount).toBe(0);
    expect(opened.detail.protectedItemKey).toBeNull();
    expect(
      ((await friend.agent.get("/shared").expect(200)).body as SharedWithMeItem[])[0]!.isNew,
    ).toBe(false);

    // Nothing in the database is the secret.
    const rows = await prisma.vaultItemField.findMany({ where: { itemId } });
    for (const r of rows) expect(r.value).not.toContain(SECRET);

    // They were told by email.
    expect(
      testOutbox.some((m) => m.to === friend.email && /shared a password/.test(m.subject)),
    ).toBe(true);
  });

  it("does not let anyone else open it, and view-only cannot edit", async () => {
    const owner = await person();
    const friend = await person();
    const stranger = await person();
    const itemId = await createLogin(owner);
    const itemKey = await giveItemKey(owner, itemId);
    await shareWith(owner, itemId, itemKey, friend.email);

    await stranger.agent.get(`/shared/items/${itemId}`).expect(404);
    await stranger.agent.get(`/vault/items/${itemId}`).expect(404);
    await stranger.agent.get(`/vault/items/${itemId}/people`).expect(404);
    await friend.agent.get(`/vault/items/${itemId}/people`).expect(404);

    const { detail, key } = await openAsRecipient(friend, itemId);
    const body = {
      id: itemId,
      type: "LOGIN",
      name: detail.name,
      revision: detail.revision,
      fields: [
        {
          key: "password",
          sensitive: true,
          value: await encryptString(key, "changed", aad.field(itemId, "password")),
        },
      ],
    };
    await friend.agent.put(`/shared/items/${itemId}`).send(body).expect(403);
  });

  it("lets an editor change the item, keeps the owner's filing, and tells the owner", async () => {
    const owner = await person();
    const friend = await person();
    const itemId = await createLogin(owner);
    await owner.agent
      .patch(`/vault/items/${itemId}`)
      .send({ tags: ["family"], favorite: true })
      .expect(200);
    const itemKey = await giveItemKey(owner, itemId);
    await shareWith(owner, itemId, itemKey, friend.email, { permission: "EDIT" });

    const { detail, key } = await openAsRecipient(friend, itemId);
    await friend.agent
      .put(`/shared/items/${itemId}`)
      .send({
        id: itemId,
        type: "LOGIN",
        name: "Netflix (family)",
        revision: detail.revision,
        tags: ["hijacked"],
        favorite: false,
        fields: [
          { key: "url", sensitive: false, value: "https://netflix.com" },
          {
            key: "password",
            sensitive: true,
            value: await encryptString(key, "New-Pass-1!", aad.field(itemId, "password")),
          },
        ],
      })
      .expect(200);

    const mine = (await owner.agent.get(`/vault/items/${itemId}`).expect(200)).body;
    expect(mine.name).toBe("Netflix (family)");
    expect(mine.tags).toEqual(["family"]);
    expect(mine.favorite).toBe(true);
    const pw = mine.fields.find((f: { key: string }) => f.key === "password");
    expect(await decryptString(itemKey, pw.value, aad.field(itemId, "password"))).toBe(
      "New-Pass-1!",
    );

    const activity = (await owner.agent.get("/activity").query({ itemId }).expect(200)).body.items;
    expect(
      activity.some(
        (a: { action: string; metadata: { via?: string } }) =>
          a.action === "item.updated" && a.metadata?.via === "share",
      ),
    ).toBe(true);
  });
});

describe("sharing with someone who is not on Minions yet", () => {
  it("invites by email, waits for a verified account with keys, then the owner seals it", async () => {
    const owner = await person();
    const itemId = await createLogin(owner, "Wi-Fi router");
    const itemKey = await giveItemKey(owner, itemId);
    const email = `new${randomUUID().slice(0, 8)}@example.com`;

    const share = await shareWith(owner, itemId, itemKey, email);
    expect(share.status).toBe("invited");
    const invite = testOutbox.find((m) => m.to === email);
    expect(invite?.subject).toMatch(/invited you/);
    expect(invite?.text).toContain(`/register?email=${encodeURIComponent(email)}`);
    expect(invite?.text).not.toContain("Wi-Fi router");

    // Signed up but not verified: sees nothing, and nothing is ready to seal.
    const unverified = await registerUser(app, email, undefined, { verifyEmail: false });
    expect((await unverified.agent.get("/shared").expect(200)).body).toEqual([]);
    expect((await owner.agent.get("/people-shares/pending-seals").expect(200)).body).toEqual([]);

    // Verified, keys set up: it shows as waiting, and the owner's client can seal it.
    const token = [...testOutbox]
      .reverse()
      .find((m) => m.to === email && /verify-email#/.test(m.text))!
      .text.match(/#([A-Za-z0-9_-]{43})/)![1];
    await unverified.agent.post("/auth/email/verify").send({ token }).expect(204);
    const friend = await withKeys(unverified);
    const waiting = (await friend.agent.get("/shared").expect(200)).body as SharedWithMeItem[];
    expect(waiting.map((w) => w.status)).toEqual(["waiting"]);
    await friend.agent.get(`/shared/items/${itemId}`).expect(404);

    const pending = (await owner.agent.get("/people-shares/pending-seals").expect(200))
      .body as PendingSeal[];
    expect(pending).toHaveLength(1);
    const p = pending[0]!;
    expect(p.recipient.id).toBe(friend.userId);
    const k = await unwrapKey(
      owner.vaultKey,
      p.protectedItemKey,
      keyAad.itemKeyForVault(owner.vaultId, itemId),
    );
    await owner.agent
      .post(`/people-shares/${p.shareId}/seal`)
      .send({
        recipientUserId: friend.userId,
        protectedItemKey: p.protectedItemKey,
        sealedItemKey: await sealKey(
          p.recipient.publicKey,
          k,
          sealContext.itemKey(itemId, friend.userId),
        ),
      })
      .expect(204);

    expect((await openAsRecipient(friend, itemId)).password).toBe(SECRET);
    expect((await owner.agent.get("/people-shares/pending-seals").expect(200)).body).toEqual([]);
  });

  it("refuses a seal for someone other than the address's verified owner", async () => {
    const owner = await person();
    const other = await person();
    const itemId = await createLogin(owner);
    const itemKey = await giveItemKey(owner, itemId);
    const email = `new${randomUUID().slice(0, 8)}@example.com`;
    const share = await shareWith(owner, itemId, itemKey, email);
    const wrapped = (await owner.agent.get(`/vault/items/${itemId}`).expect(200)).body
      .protectedItemKey;
    await owner.agent
      .post(`/people-shares/${share.id}/seal`)
      .send({
        recipientUserId: other.userId,
        protectedItemKey: wrapped,
        sealedItemKey: await sealKey(
          other.publicKey,
          itemKey,
          sealContext.itemKey(itemId, other.userId),
        ),
      })
      .expect(400);
    // And a direct share must name the account that really has the address.
    await owner.agent
      .post(`/vault/items/${itemId}/people`)
      .send({
        email: `x${randomUUID().slice(0, 6)}@example.com`,
        permission: "VIEW",
        expiresInMinutes: 0,
        recipientUserId: other.userId,
        sealedItemKey: await sealKey(
          other.publicKey,
          itemKey,
          sealContext.itemKey(itemId, other.userId),
        ),
      })
      .expect(400);
  });
});

describe("ending a share", () => {
  it("removing someone flags the item, and a re-key leaves them out", async () => {
    const owner = await person();
    const a = await person();
    const b = await person();
    const itemId = await createLogin(owner);
    const itemKey = await giveItemKey(owner, itemId);
    const sa = await shareWith(owner, itemId, itemKey, a.email);
    await shareWith(owner, itemId, itemKey, b.email);

    const r = await owner.agent.delete(`/vault/items/${itemId}/people/${sa.id}`).expect(200);
    expect(r.body.rekeyNeeded).toBe(true);
    await a.agent.get(`/shared/items/${itemId}`).expect(404);
    expect((await owner.agent.get(`/vault/items/${itemId}`).expect(200)).body.rekeyNeeded).toBe(
      true,
    );

    // The re-key must re-seal to everyone who keeps access.
    const material = (await owner.agent.get(`/vault/items/${itemId}/item-key`).expect(200)).body;
    expect(material.holders.map((h: { userId: string }) => h.userId)).toEqual([b.userId]);
    const wrapped = await wrapKey(
      owner.vaultKey,
      generateKey(),
      keyAad.itemKeyForVault(owner.vaultId, itemId),
    );
    await owner.agent
      .post(`/vault/items/${itemId}/item-key`)
      .send({
        revision: material.revision,
        fields: material.fields,
        versions: material.versions,
        protectedItemKey: wrapped,
        seals: [],
      })
      .expect(400);
    const next = await giveItemKey(owner, itemId, itemKey);
    expect((await owner.agent.get(`/vault/items/${itemId}`).expect(200)).body.rekeyNeeded).toBe(
      false,
    );
    const opened = await openAsRecipient(b, itemId);
    expect(Buffer.from(opened.key).equals(Buffer.from(next))).toBe(true);
    expect(opened.password).toBe(SECRET);
  });

  it("an expired share stops working; a recipient can leave", async () => {
    const owner = await person();
    const friend = await person();
    const itemId = await createLogin(owner);
    const itemKey = await giveItemKey(owner, itemId);
    const share = await shareWith(owner, itemId, itemKey, friend.email, { expiresInMinutes: 60 });
    expect(share.expiresAt).not.toBeNull();
    await prisma.itemShare.update({
      where: { id: share.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await friend.agent.get(`/shared/items/${itemId}`).expect(404);
    expect((await friend.agent.get("/shared").expect(200)).body).toEqual([]);
    const listed = (await owner.agent.get(`/vault/items/${itemId}/people`).expect(200))
      .body as PeopleShare[];
    expect(listed[0]!.status).toBe("expired");

    // Extend it, then the recipient removes it themselves.
    await owner.agent
      .patch(`/vault/items/${itemId}/people/${share.id}`)
      .send({ expiresInMinutes: 0 })
      .expect(200);
    await friend.agent.get(`/shared/items/${itemId}`).expect(200);
    await friend.agent.delete(`/shared/${share.id}`).expect(204);
    expect((await owner.agent.get(`/vault/items/${itemId}/people`).expect(200)).body).toEqual([]);
  });

  it("an item in the owner's trash is not shared", async () => {
    const owner = await person();
    const friend = await person();
    const itemId = await createLogin(owner);
    const itemKey = await giveItemKey(owner, itemId);
    await shareWith(owner, itemId, itemKey, friend.email);
    await owner.agent.delete(`/vault/items/${itemId}`).expect(204);
    await friend.agent.get(`/shared/items/${itemId}`).expect(404);
  });
});

describe("the extension", () => {
  it("finds shared logins for the site and by search, only for the recipient", async () => {
    const owner = await person();
    const friend = await person();
    const stranger = await person();
    const itemId = await createLogin(owner);
    const itemKey = await giveItemKey(owner, itemId);
    await shareWith(owner, itemId, itemKey, friend.email);

    const m = (
      await friend.agent.get("/shared/match").query({ host: "www.netflix.com" }).expect(200)
    ).body as SharedWithMeItem[];
    expect(m.map((i) => i.id)).toEqual([itemId]);
    expect(m[0]!.sharedBy.email).toBe(owner.email);
    // Look-alike sites get nothing.
    expect(
      (await friend.agent.get("/shared/match").query({ host: "netflix.com.evil.io" })).body,
    ).toEqual([]);
    expect((await friend.agent.get("/shared/search").query({ q: "netflix" })).body).toHaveLength(1);
    expect((await stranger.agent.get("/shared/match").query({ host: "netflix.com" })).body).toEqual(
      [],
    );
  });
});

describe("guards", () => {
  it("an unverified sender cannot share or look people up", async () => {
    const owner = await withKeys(
      await registerUser(app, undefined, undefined, { verifyEmail: false }),
    );
    await owner.agent.get("/people-shares/lookup").query({ email: "a@example.com" }).expect(403);
  });

  it("lookup never reports an unverified account, and refuses your own address", async () => {
    const owner = await person();
    const unverified = await withKeys(
      await registerUser(app, undefined, undefined, { verifyEmail: false }),
    );
    const res = await owner.agent
      .get("/people-shares/lookup")
      .query({ email: unverified.email })
      .expect(200);
    expect(res.body.recipient).toBeNull();
    await owner.agent.get("/people-shares/lookup").query({ email: owner.email }).expect(400);
  });

  it("vault-key rotation re-wraps a shared item's key and leaves its fields alone", async () => {
    const owner = await person();
    const friend = await person();
    const itemId = await createLogin(owner);
    const itemKey = await giveItemKey(owner, itemId);
    await shareWith(owner, itemId, itemKey, friend.email);
    const before = await prisma.vaultItemField.findMany({
      where: { itemId },
      orderBy: { key: "asc" },
    });

    const fresh = generateKey();
    await owner.agent
      .post("/vault/rotation/start")
      .send({
        authKey: owner.authKey,
        protectedVaultKey: await wrapKey(owner.vaultKey, fresh, "x"),
      })
      .expect(200);
    const batch = (
      await owner.agent.get("/vault/rotation/batch").query({ kind: "items" }).expect(200)
    ).body.items;
    const row = batch.find((i: { id: string }) => i.id === itemId);
    expect(row.protectedItemKey).toBeTruthy();
    expect(row.versions).toEqual([]);
    // Sending its fields instead of its key is refused.
    await owner.agent
      .post("/vault/rotation/batch")
      .send({ items: [{ id: itemId, fields: row.fields, versions: [] }] })
      .expect(400);
    await owner.agent
      .post("/vault/rotation/batch")
      .send({
        items: [
          {
            id: itemId,
            fields: [],
            versions: [],
            protectedItemKey: await wrapKey(
              fresh,
              itemKey,
              keyAad.itemKeyForVault(owner.vaultId, itemId),
            ),
          },
        ],
      })
      .expect(200);
    const after = await prisma.vaultItemField.findMany({
      where: { itemId },
      orderBy: { key: "asc" },
    });
    expect(after.map((f) => f.value)).toEqual(before.map((f) => f.value));
    // The recipient is unaffected.
    expect((await openAsRecipient(friend, itemId)).password).toBe(SECRET);
  });
});
