import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  aad,
  createAccountKeys,
  deriveMasterKeys,
  encryptString,
  estimateStrength,
  getItemType,
  type ItemField,
  type KdfParams,
  secretFingerprint,
  type UpsertItemRequest,
  unwrapKey,
} from "@minions/core";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/bootstrap";
import { PrismaService } from "../src/common/prisma.service";
import { testOutbox } from "../src/mail/mailer";

// The server's floor; real clients use more.
export const TEST_KDF: Omit<KdfParams, "salt"> = {
  type: "argon2id",
  memory: 19456,
  iterations: 2,
  parallelism: 1,
};

export async function createApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}

const TABLES = [
  "item_shares",
  "workspace_item_favorites",
  "workspace_item_grants",
  "workspace_members",
  "workspaces",
  "import_items",
  "import_jobs",
  "user_classification_preferences",
  "ai_classifications",
  "security_findings",
  "security_events",
  "activity_logs",
  "note_tags",
  "note_versions",
  "notes",
  "item_project_links",
  "vault_item_relations",
  "vault_item_tags",
  "vault_item_versions",
  "vault_item_fields",
  "vault_items",
  "tags",
  "collections",
  "projects",
  "vaults",
  "sessions",
  "devices",
  "webauthn_credentials",
  "recovery_codes",
  "users",
];

export async function resetDb(prisma: PrismaService) {
  const db = (await prisma.$queryRawUnsafe<{ d: string }[]>("SELECT current_database() AS d"))[0]!
    .d;
  if (!db.endsWith("_test")) throw new Error(`Refusing to truncate non-test database ${db}`);
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
}

export interface TestUser {
  agent: TestAgent;
  email: string;
  password: string;
  userId: string;
  vaultId: string;
  vaultKey: Uint8Array<ArrayBuffer>;
  authKey: string;
  kdf: KdfParams;
  clientDeviceId: string;
}

export const WEB = { "x-minions-client": "web" };

/** The token from the newest verification email sent to `email` (test outbox). */
export function verificationToken(email: string): string {
  const mail = [...testOutbox].reverse().find((m) => m.to === email);
  const token = mail?.text.match(/\/verify-email#([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error(`no verification email for ${email}`);
  return token;
}

export async function registerUser(
  app: INestApplication,
  email = `u${randomUUID().slice(0, 8)}@example.com`,
  password = "correct horse battery staple",
  opts: { verifyEmail?: boolean } = {},
): Promise<TestUser> {
  const agent = request.agent(app.getHttpServer()).set(WEB);
  const userId = randomUUID();
  const vaultId = randomUUID();
  const kdf = {
    ...TEST_KDF,
    salt: Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("base64"),
  };
  const keys = await createAccountKeys(password, userId, vaultId, kdf);
  const clientDeviceId = randomUUID();
  const res = await agent.post("/auth/register").send({
    email,
    name: "Test User",
    userId,
    vaultId,
    authKey: keys.authKey,
    kdf,
    protectedUserKey: keys.protectedUserKey,
    protectedVaultKey: keys.protectedVaultKey,
    device: { clientDeviceId, name: "Test browser", kind: "web" },
  });
  if (res.status !== 201)
    throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  // Confirms the address through the real link, as a person would.
  if (opts.verifyEmail !== false) {
    const token = verificationToken(email);
    const ok = await request(app.getHttpServer())
      .post("/auth/email/verify")
      .set(WEB)
      .send({ token });
    if (ok.status !== 204) throw new Error(`verify failed ${ok.status}`);
  }
  return {
    agent,
    email,
    password,
    userId,
    vaultId,
    vaultKey: keys.vaultKey,
    authKey: keys.authKey,
    kdf,
    clientDeviceId,
  };
}

/** Logs in from a fresh agent, as a new or the same device. */
export async function login(
  app: INestApplication,
  user: TestUser,
  opts: { clientDeviceId?: string; kind?: "web" | "extension" } = {},
) {
  const agent = request.agent(app.getHttpServer()).set(WEB);
  const pre = await agent.post("/auth/prelogin").send({ email: user.email });
  const { authKey, stretchedKey } = await deriveMasterKeys(user.password, pre.body.kdf);
  const res = await agent.post("/auth/login").send({
    email: user.email,
    authKey,
    device: {
      clientDeviceId: opts.clientDeviceId ?? user.clientDeviceId,
      name: "Another browser",
      kind: opts.kind ?? "web",
    },
  });
  return { agent, res, stretchedKey, authKey };
}

export async function vaultKeyFrom(
  stretchedKey: Uint8Array<ArrayBuffer>,
  keys: { userId: string; vaultId: string; protectedUserKey: string; protectedVaultKey: string },
) {
  const userKey = await unwrapKey(stretchedKey, keys.protectedUserKey, aad.userKey(keys.userId));
  return unwrapKey(userKey, keys.protectedVaultKey, aad.vaultKey(keys.vaultId));
}

/** Builds an item exactly as the web client does: sensitive fields encrypted with field AAD. */
export async function buildItem(
  user: Pick<TestUser, "vaultKey">,
  type: string,
  name: string,
  values: Record<string, string>,
  extra: Partial<UpsertItemRequest> = {},
): Promise<UpsertItemRequest> {
  const id = extra.id ?? randomUUID();
  const def = getItemType(type)!;
  const fields: ItemField[] = [];
  for (const [key, value] of Object.entries(values)) {
    const f = def.fields.find((x) => x.key === key);
    const sensitive = f ? f.sensitive : true;
    fields.push({
      key,
      sensitive,
      value: sensitive ? await encryptString(user.vaultKey, value, aad.field(id, key)) : value,
    });
  }
  const pw = def.passwordField ? values[def.passwordField] : undefined;
  return {
    id,
    type,
    name,
    fields,
    signals: pw
      ? {
          passwordStrength: estimateStrength(pw).score,
          passwordFingerprint: await secretFingerprint(user.vaultKey, pw),
        }
      : undefined,
    ...extra,
  };
}
