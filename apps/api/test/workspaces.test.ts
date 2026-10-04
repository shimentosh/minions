import { randomUUID } from "node:crypto";
import {
  aad,
  decryptString,
  encryptBytes,
  generateKey,
  generateUserKeyPair,
  importPrivateKey,
  keyAad,
  openSealedKey,
  protectPrivateKey,
  sealContext,
  sealKey,
  unwrapKey,
  type WorkspaceItemDetail,
  type WorkspaceMember,
} from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import type { PrismaService } from "../src/common/prisma.service";
import { buildItem, createApp, registerUser, resetDb, type TestUser } from "./helpers";

/**
 * Workspaces and sharing: every rule here is enforced by the server, and the
 * keys involved never let the server read a credential.
 */

let app: INestApplication;
let prisma: PrismaService;

interface Member extends TestUser {
  publicKey: string;
  privateKey: CryptoKey;
}

beforeAll(async () => {
  ({ app, prisma } = await createApp());
});
afterAll(async () => {
  await app.close();
});

const SECRET = "Team-Secret-NEVER-IN-DB-42!";

async function withKeys(user: TestUser): Promise<Member> {
  const pair = await generateUserKeyPair();
  const userKey = generateKey();
  await user.agent
    .post("/account/keypair")
    .send({
      publicKey: pair.publicKey,
      protectedPrivateKey: await protectPrivateKey(userKey, pair.privateKey, user.userId),
    })
    .expect(204);
  return {
    ...user,
    publicKey: pair.publicKey,
    privateKey: await importPrivateKey(pair.privateKey),
  };
}

async function newMember() {
  return withKeys(await registerUser(app));
}

interface Ws {
  id: string;
  key: Uint8Array<ArrayBuffer>;
}

async function createWorkspace(owner: Member, name = "Acme"): Promise<Ws> {
  const id = randomUUID();
  const key = generateKey();
  await owner.agent
    .post("/workspaces")
    .send({
      id,
      name,
      protectedWorkspaceKey: await sealKey(
        owner.publicKey,
        key,
        sealContext.workspaceKey(id, owner.userId),
      ),
    })
    .expect(201);
  return { id, key };
}

/** Invite → accept → confirm, the way the clients do it. */
async function join(ws: Ws, admin: Member, user: Member, role: "MEMBER" | "ADMIN" = "MEMBER") {
  await admin.agent
    .post(`/workspaces/${ws.id}/members`)
    .send({ email: user.email, role })
    .expect(201);
  const inv = await user.agent.get("/workspaces/invitations").expect(200);
  const invite = inv.body.find((i: { workspaceId: string }) => i.workspaceId === ws.id);
  await user.agent.post(`/workspaces/invitations/${invite.id}/accept`).expect(200);
  const members = (await admin.agent.get(`/workspaces/${ws.id}/members`).expect(200))
    .body as WorkspaceMember[];
  const m = members.find((x) => x.userId === user.userId)!;
  expect(m.status).toBe("ACCEPTED");
  expect(m.publicKey).toBe(user.publicKey);
  await admin.agent
    .post(`/workspaces/${ws.id}/members/${m.id}/confirm`)
    .send({
      protectedWorkspaceKey: await sealKey(
        m.publicKey!,
        ws.key,
        sealContext.workspaceKey(ws.id, user.userId),
      ),
    })
    .expect(204);
  return m.id;
}

interface Grant {
  user: Member;
  permission: "VIEW" | "MANAGE";
}

async function createItem(
  ws: Ws,
  creator: Member,
  opts: { name?: string; url?: string; grants?: Grant[]; everyone?: boolean } = {},
) {
  const itemKey = generateKey();
  const id = randomUUID();
  const item = await buildItem(
    { vaultKey: itemKey },
    "LOGIN",
    opts.name ?? "Cloudflare",
    {
      url: opts.url ?? "https://dash.cloudflare.com/login",
      username: "ops@acme.test",
      password: SECRET,
    },
    { id },
  );
  const grants = [{ user: creator, permission: "MANAGE" as const }, ...(opts.grants ?? [])];
  const res = await creator.agent.post(`/workspaces/${ws.id}/items`).send({
    item,
    access: {
      workspaceShared: !!opts.everyone,
      ...(opts.everyone
        ? {
            workspaceWrappedKey: await encryptBytes(
              ws.key,
              itemKey,
              keyAad.itemKeyForWorkspace(ws.id, id),
            ),
          }
        : {}),
      grants: await Promise.all(
        grants.map(async (g) => ({
          userId: g.user.userId,
          permission: g.permission,
          protectedItemKey: await sealKey(
            g.user.publicKey,
            itemKey,
            sealContext.itemKey(id, g.user.userId),
          ),
        })),
      ),
    },
  });
  expect(res.status).toBe(201);
  return { id, itemKey };
}

/** What a client does to read the password: open the item key, then the field. */
async function readPassword(
  user: Member,
  ws: Ws,
  detail: WorkspaceItemDetail,
  wsKey?: Uint8Array<ArrayBuffer>,
) {
  const key =
    detail.key.source === "grant"
      ? await openSealedKey(
          user.privateKey,
          detail.key.wrapped,
          sealContext.itemKey(detail.id, user.userId),
        )
      : await unwrapKey(wsKey!, detail.key.wrapped, keyAad.itemKeyForWorkspace(ws.id, detail.id));
  const f = detail.fields.find((x) => x.key === "password")!;
  return decryptString(key, f.value, aad.field(detail.id, "password"));
}

let alice: Member; // owner
let bob: Member; // member
let ws: Ws;

beforeEach(async () => {
  await resetDb(prisma);
  alice = await newMember();
  bob = await newMember();
  ws = await createWorkspace(alice);
  await join(ws, alice, bob);
});

describe("sharing keys", () => {
  it("accepts one RSA-3072 key pair and refuses to replace it", async () => {
    await alice.agent
      .post("/account/keypair")
      .send({
        publicKey: alice.publicKey,
        protectedPrivateKey: `v1.AAAAAAAAAAAAAAAA.${"A".repeat(200)}`,
      })
      .expect(409);
    const fresh = await registerUser(app);
    await fresh.agent
      .post("/account/keypair")
      .send({
        publicKey: "A".repeat(560),
        protectedPrivateKey: `v1.AAAAAAAAAAAAAAAA.${"A".repeat(200)}`,
      })
      .expect(400);
  });

  it("needs a key pair before creating or joining a workspace", async () => {
    const fresh = await registerUser(app);
    const res = await fresh.agent
      .post("/workspaces")
      .send({ id: randomUUID(), name: "X", protectedWorkspaceKey: `r1.${"A".repeat(512)}` });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("KEYPAIR_REQUIRED");
  });
});

describe("membership", () => {
  it("hides a workspace from non-members", async () => {
    const eve = await newMember();
    await eve.agent.get(`/workspaces/${ws.id}`).expect(404);
    await eve.agent.get(`/workspaces/${ws.id}/items`).expect(404);
    await eve.agent.get(`/workspaces/${ws.id}/members`).expect(404);
    expect((await eve.agent.get("/workspaces").expect(200)).body).toEqual([]);
  });

  it("gives a joined but unconfirmed member nothing", async () => {
    const carol = await newMember();
    await alice.agent
      .post(`/workspaces/${ws.id}/members`)
      .send({ email: carol.email, role: "MEMBER" })
      .expect(201);
    const [inv] = (await carol.agent.get("/workspaces/invitations").expect(200)).body;
    await carol.agent.post(`/workspaces/invitations/${inv.id}/accept`).expect(200);
    await createItem(ws, alice, { everyone: true });
    const res = await carol.agent.get(`/workspaces/${ws.id}/items`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MEMBERSHIP_PENDING");
    const detail = (await carol.agent.get(`/workspaces/${ws.id}`).expect(200)).body;
    expect(detail.protectedWorkspaceKey).toBeNull();
  });

  it("lets only the invited email accept, and invites do not reveal accounts", async () => {
    await alice.agent
      .post(`/workspaces/${ws.id}/members`)
      .send({ email: "nobody-here@example.com", role: "MEMBER" })
      .expect(201);
    const eve = await newMember();
    const pending = await prisma.workspaceMember.findFirstOrThrow({
      where: { email: "nobody-here@example.com" },
    });
    await eve.agent.post(`/workspaces/invitations/${pending.id}/accept`).expect(404);
  });

  it("enforces roles", async () => {
    const carol = await newMember();
    await bob.agent
      .post(`/workspaces/${ws.id}/members`)
      .send({ email: carol.email, role: "MEMBER" })
      .expect(403);
    const members = (await alice.agent.get(`/workspaces/${ws.id}/members`))
      .body as WorkspaceMember[];
    const owner = members.find((m) => m.role === "OWNER")!;
    await bob.agent.delete(`/workspaces/${ws.id}/members/${owner.id}`).expect(403);
    await bob.agent.delete(`/workspaces/${ws.id}`).expect(403);
    await alice.agent.post(`/workspaces/${ws.id}/leave`).expect(400);
  });
});

describe("credential access", () => {
  it("keeps a private credential private, owners of the workspace included", async () => {
    const { id } = await createItem(ws, bob, { name: "Bob's private" });
    await alice.agent.get(`/workspaces/${ws.id}/items/${id}`).expect(404);
    const list = (await alice.agent.get(`/workspaces/${ws.id}/items`).expect(200)).body;
    expect(list.items).toEqual([]);
    expect(
      (await alice.agent.get("/workspaces/items/match").query({ host: "dash.cloudflare.com" }))
        .body,
    ).toEqual([]);
  });

  it("shares with a specific member, view-only", async () => {
    const { id } = await createItem(ws, alice, { grants: [{ user: bob, permission: "VIEW" }] });
    const detail = (await bob.agent.get(`/workspaces/${ws.id}/items/${id}`).expect(200))
      .body as WorkspaceItemDetail;
    expect(detail.permission).toBe("VIEW");
    expect(detail.versionCount).toBe(0);
    expect(await readPassword(bob, ws, detail)).toBe(SECRET);

    // View-only: every change is refused on the server.
    const edit = await buildItem(
      { vaultKey: generateKey() },
      "LOGIN",
      "Hijack",
      { password: "x" },
      { id },
    );
    await bob.agent.put(`/workspaces/${ws.id}/items/${id}`).send(edit).expect(403);
    await bob.agent.delete(`/workspaces/${ws.id}/items/${id}`).expect(403);
    await bob.agent.get(`/workspaces/${ws.id}/items/${id}/versions`).expect(403);
    await bob.agent
      .put(`/workspaces/${ws.id}/items/${id}/access`)
      .send({ workspaceShared: false, grants: [{ userId: bob.userId, permission: "MANAGE" }] })
      .expect(403);
    // A personal favorite is fine.
    await bob.agent.patch(`/workspaces/${ws.id}/items/${id}`).send({ favorite: true }).expect(200);
    const mine = (await bob.agent.get(`/workspaces/${ws.id}/items`).query({ favorite: "true" }))
      .body;
    const hers = (await alice.agent.get(`/workspaces/${ws.id}/items`).query({ favorite: "true" }))
      .body;
    expect(mine.items).toHaveLength(1);
    expect(hers.items).toHaveLength(0);
  });

  it("stops working as soon as access is revoked, and flags the key", async () => {
    const { id } = await createItem(ws, alice, { grants: [{ user: bob, permission: "VIEW" }] });
    await bob.agent.get(`/workspaces/${ws.id}/items/${id}`).expect(200);
    const res = await alice.agent
      .put(`/workspaces/${ws.id}/items/${id}/access`)
      .send({ workspaceShared: false, grants: [{ userId: alice.userId, permission: "MANAGE" }] })
      .expect(200);
    expect(res.body.grants).toHaveLength(1);
    await bob.agent.get(`/workspaces/${ws.id}/items/${id}`).expect(404);
    await bob.agent
      .post(`/workspaces/${ws.id}/items/${id}/usage`)
      .send({ action: "item.copied" })
      .expect(404);
    expect((await prisma.vaultItem.findUniqueOrThrow({ where: { id } })).rekeyNeeded).toBe(true);
  });

  it("shares with everyone confirmed in the workspace through the workspace key", async () => {
    const carol = await newMember();
    await join(ws, alice, carol);
    const { id } = await createItem(ws, alice, { everyone: true });
    const detail = (await carol.agent.get(`/workspaces/${ws.id}/items/${id}`).expect(200))
      .body as WorkspaceItemDetail;
    expect(detail.key.source).toBe("workspace");
    // Carol opens the workspace key sealed to her, then the item.
    const me = (await carol.agent.get(`/workspaces/${ws.id}`).expect(200)).body;
    const wsKey = await openSealedKey(
      carol.privateKey,
      me.protectedWorkspaceKey,
      sealContext.workspaceKey(ws.id, carol.userId),
    );
    expect(await readPassword(carol, ws, detail, wsKey)).toBe(SECRET);
  });

  it("refuses grants to people outside the workspace, and grants without a key", async () => {
    const eve = await newMember();
    const { id, itemKey } = await createItem(ws, alice);
    const r1 = await alice.agent.put(`/workspaces/${ws.id}/items/${id}/access`).send({
      workspaceShared: false,
      grants: [
        { userId: alice.userId, permission: "MANAGE" },
        {
          userId: eve.userId,
          permission: "VIEW",
          protectedItemKey: await sealKey(
            eve.publicKey,
            itemKey,
            sealContext.itemKey(id, eve.userId),
          ),
        },
      ],
    });
    expect(r1.status).toBe(404);
    expect(r1.body.code).toBe("MEMBER_NOT_FOUND");
    const r2 = await alice.agent.put(`/workspaces/${ws.id}/items/${id}/access`).send({
      workspaceShared: false,
      grants: [
        { userId: alice.userId, permission: "MANAGE" },
        { userId: bob.userId, permission: "VIEW" },
      ],
    });
    expect(r2.status).toBe(400);
    expect(r2.body.code).toBe("KEY_REQUIRED");
    const r3 = await alice.agent
      .put(`/workspaces/${ws.id}/items/${id}/access`)
      .send({ workspaceShared: false, grants: [] });
    expect(r3.body.code).toBe("NO_MANAGER");
  });

  it("requires the creator to keep a key", async () => {
    const item = await buildItem({ vaultKey: generateKey() }, "LOGIN", "X", { password: "p" });
    const res = await bob.agent
      .post(`/workspaces/${ws.id}/items`)
      .send({ item, access: { workspaceShared: false, grants: [] } });
    expect(res.body.code).toBe("CREATOR_GRANT_REQUIRED");
  });

  it("refuses plaintext secrets, as the personal vault does", async () => {
    const item = await buildItem({ vaultKey: generateKey() }, "LOGIN", "X", {
      url: "https://x.test",
    });
    item.fields.push({ key: "password", value: "plain-text", sensitive: true });
    const res = await bob.agent.post(`/workspaces/${ws.id}/items`).send({
      item,
      access: {
        workspaceShared: false,
        grants: [
          {
            userId: bob.userId,
            permission: "MANAGE",
            protectedItemKey: await sealKey(
              bob.publicKey,
              generateKey(),
              sealContext.itemKey(item.id, bob.userId),
            ),
          },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PLAINTEXT_SECRET");
  });

  it("deleted credentials stop working for everyone who is not a manager", async () => {
    const { id } = await createItem(ws, alice, { grants: [{ user: bob, permission: "VIEW" }] });
    await alice.agent.delete(`/workspaces/${ws.id}/items/${id}`).expect(204);
    await bob.agent.get(`/workspaces/${ws.id}/items/${id}`).expect(404);
    expect(
      (await bob.agent.get(`/workspaces/${ws.id}/items`).query({ trash: "true" })).body.items,
    ).toEqual([]);
    expect(
      (await alice.agent.get(`/workspaces/${ws.id}/items`).query({ trash: "true" })).body.items,
    ).toHaveLength(1);
    await alice.agent.delete(`/workspaces/${ws.id}/items/${id}/purge`).expect(204);
    await alice.agent.get(`/workspaces/${ws.id}/items/${id}`).expect(404);
  });
});

describe("isolation", () => {
  it("never reaches an item through another workspace, or through the personal vault", async () => {
    const dave = await newMember();
    const other = await createWorkspace(dave, "Other");
    const { id } = await createItem(ws, alice, { everyone: true });
    // Dave's own workspace id with Alice's item id.
    await dave.agent.get(`/workspaces/${other.id}/items/${id}`).expect(404);
    await dave.agent.delete(`/workspaces/${other.id}/items/${id}`).expect(404);
    // Alice's personal vault routes do not see workspace items.
    await alice.agent.get(`/vault/items/${id}`).expect(404);
    await alice.agent.delete(`/vault/items/${id}`).expect(404);
    expect((await alice.agent.get("/vault/items").expect(200)).body.items).toEqual([]);
    // Nor can a personal relation point at one.
    const personal = await buildItem(alice, "LOGIN", "Mine", { password: "p" });
    await alice.agent.post("/vault/items").send(personal).expect(201);
    await alice.agent
      .post("/relations")
      .send({ fromItemId: personal.id, toItemId: id, kind: "RELATED" })
      .expect(404);
  });

  it("matches sites safely for the extension", async () => {
    await createItem(ws, alice, {
      name: "Example",
      url: "https://app.example.com/login",
      everyone: true,
    });
    await createItem(ws, alice, { name: "UK", url: "https://shop.other.co.uk", everyone: true });
    const hosts = async (host: string) =>
      (
        (await bob.agent.get("/workspaces/items/match").query({ host })).body as { name: string }[]
      ).map((i) => i.name);
    expect(await hosts("app.example.com")).toEqual(["Example"]);
    expect(await hosts("example.com")).toEqual(["Example"]);
    expect(await hosts("example-login.com")).toEqual([]);
    expect(await hosts("evil-example.com")).toEqual([]);
    expect(await hosts("evil.co.uk")).toEqual([]);
  });
});

describe("removing a member", () => {
  it("cuts access at once, deletes what only they could open and flags the rest for re-keying", async () => {
    const { id: shared } = await createItem(ws, alice, {
      grants: [{ user: bob, permission: "VIEW" }],
    });
    const { id: everyone } = await createItem(ws, alice, { name: "All", everyone: true });
    const { id: bobsOwn } = await createItem(ws, bob, { name: "Only Bob" });
    const members = (await alice.agent.get(`/workspaces/${ws.id}/members`))
      .body as WorkspaceMember[];
    const bobRow = members.find((m) => m.userId === bob.userId)!;

    const profile = (await alice.agent.get(`/workspaces/${ws.id}/members/${bobRow.id}`).expect(200))
      .body;
    // Alice sees Bob's access to what she can open, never "Only Bob".
    expect(profile.credentials.map((c: { id: string }) => c.id).sort()).toEqual(
      [shared, everyone].sort(),
    );
    expect(profile.soleAccessCount).toBe(1);
    expect(JSON.stringify(profile)).not.toContain("protectedItemKey");

    const res = await alice.agent.delete(`/workspaces/${ws.id}/members/${bobRow.id}`).expect(200);
    expect(res.body.deleted).toBe(1);
    await bob.agent.get(`/workspaces/${ws.id}/items/${shared}`).expect(404);
    await bob.agent.get(`/workspaces/${ws.id}/items/${everyone}`).expect(404);
    await bob.agent.get(`/workspaces/${ws.id}`).expect(404);
    expect(await prisma.vaultItem.findUnique({ where: { id: bobsOwn } })).toBeNull();
    const flagged = await prisma.vaultItem.findMany({ where: { id: { in: [shared, everyone] } } });
    expect(flagged.every((i) => i.rekeyNeeded)).toBe(true);
    expect((await alice.agent.get(`/workspaces/${ws.id}`)).body.rekeyNeeded).toBe(true);
  });

  it("re-keys an item: the new key works, the old one opens nothing, history is dropped", async () => {
    const { id, itemKey } = await createItem(ws, alice, {
      grants: [{ user: bob, permission: "MANAGE" }],
    });
    // An edit leaves a version encrypted with the old key.
    const v2 = await buildItem(
      { vaultKey: itemKey },
      "LOGIN",
      "Cloudflare",
      { password: "second" },
      { id, revision: 1 },
    );
    await alice.agent.put(`/workspaces/${ws.id}/items/${id}`).send(v2).expect(200);

    const newKey = generateKey();
    const item = await buildItem(
      { vaultKey: newKey },
      "LOGIN",
      "Cloudflare",
      { password: "rotated" },
      { id, revision: 2 },
    );
    const grants = await Promise.all(
      [alice, bob].map(async (u) => ({
        userId: u.userId,
        permission: "MANAGE",
        protectedItemKey: await sealKey(u.publicKey, newKey, sealContext.itemKey(id, u.userId)),
      })),
    );
    await alice.agent
      .post(`/workspaces/${ws.id}/items/${id}/rekey`)
      .send({ item, access: { workspaceShared: false, grants } })
      .expect(200);
    const detail = (await bob.agent.get(`/workspaces/${ws.id}/items/${id}`))
      .body as WorkspaceItemDetail;
    expect(await readPassword(bob, ws, detail)).toBe("rotated");
    expect(detail.rekeyNeeded).toBe(false);
    expect(detail.versionCount).toBe(0);
    const f = detail.fields.find((x) => x.key === "password")!;
    await expect(decryptString(itemKey, f.value, aad.field(id, "password"))).rejects.toThrow();

    // A re-key must carry the new key for every grant.
    const partial = await alice.agent.post(`/workspaces/${ws.id}/items/${id}/rekey`).send({
      item: { ...item, revision: 3 },
      access: { workspaceShared: false, grants: [{ userId: alice.userId, permission: "MANAGE" }] },
    });
    expect(partial.body.code).toBe("KEY_REQUIRED");
  });
});

describe("audit log", () => {
  it("records who did what, without secrets", async () => {
    const { id } = await createItem(ws, alice, { grants: [{ user: bob, permission: "VIEW" }] });
    await bob.agent.get(`/workspaces/${ws.id}/items/${id}`).expect(200);
    await bob.agent
      .post(`/workspaces/${ws.id}/items/${id}/usage`)
      .send({ action: "item.copied", field: "password" })
      .expect(204);

    const log = (await alice.agent.get(`/workspaces/${ws.id}/activity`).expect(200)).body.items as {
      action: string;
      actor: { id: string };
      itemName: string | null;
      ip: string | null;
    }[];
    const byBob = log.filter((e) => e.actor.id === bob.userId).map((e) => e.action);
    expect(byBob).toEqual(
      expect.arrayContaining(["item.viewed", "item.copied", "workspace.member_joined"]),
    );
    expect(log.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "workspace.created",
        "workspace.member_invited",
        "workspace.member_confirmed",
        "item.created",
        "item.shared",
      ]),
    );
    // Other people's IP addresses are not shown to the workspace.
    expect(log.every((e) => e.ip === null)).toBe(true);
    expect(JSON.stringify(log)).not.toContain(SECRET);

    // Members see their own actions only.
    const own = (await bob.agent.get(`/workspaces/${ws.id}/activity`).expect(200)).body.items as {
      actor: { id: string };
    }[];
    expect(own.every((e) => e.actor.id === bob.userId)).toBe(true);

    // Item managers see who used it.
    const itemLog = (await alice.agent.get(`/workspaces/${ws.id}/items/${id}/activity`).expect(200))
      .body.items;
    expect(
      itemLog.some(
        (e: { action: string; actor: { id: string } }) =>
          e.action === "item.copied" && e.actor.id === bob.userId,
      ),
    ).toBe(true);
    await bob.agent.get(`/workspaces/${ws.id}/items/${id}/activity`).expect(403);
  });

  it("stores no plaintext secret anywhere", async () => {
    await createItem(ws, alice, { grants: [{ user: bob, permission: "VIEW" }] });
    await createItem(ws, alice, { name: "All", everyone: true });
    const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'",
    );
    let dump = "";
    for (const { table_name } of tables)
      dump += JSON.stringify(
        await prisma.$queryRawUnsafe(`SELECT * FROM "${table_name}"`),
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      );
    expect(dump).not.toContain(SECRET);
  });
});

describe("locked vault", () => {
  it("refuses workspace routes until unlocked", async () => {
    await alice.agent.post("/vault/lock").expect(204);
    const res = await alice.agent.get(`/workspaces/${ws.id}/items`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("VAULT_LOCKED");
  });
});
