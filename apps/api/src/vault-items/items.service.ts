import {
  CUSTOM_FIELD_PREFIX,
  getItemType,
  type ItemCategory,
  type ItemField,
  type ItemVersion,
  isEnvelope,
  matchHost,
  normalizeHost,
  type Page,
  type RelationKind,
  registrableDomain,
  resolveField,
  typesInCategory,
  type VaultItemDetail,
  type VaultItemSummary,
} from "@minions/core";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { type Action, ActivityService } from "../activity/activity.service";
import type { AuthContext } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { FindingsStore } from "../security/findings-store";
import type { ItemFieldDto, ListItemsQuery, PatchItemDto, UpsertItemDto } from "./items.dto";

const SUMMARY_INCLUDE = {
  project: { select: { id: true, name: true, color: true } },
  collection: { select: { id: true, name: true, color: true } },
  tags: { select: { tag: { select: { name: true } } } },
} satisfies Prisma.VaultItemInclude;

type ItemWithSummary = Prisma.VaultItemGetPayload<{ include: typeof SUMMARY_INCLUDE }>;

const HOST_FIELDS = ["url", "base_url", "console_url", "endpoint", "docs_url"];
const USERNAME_FIELDS = ["username", "email", "account", "licensed_to"];
const PROVIDER_FIELDS = [
  "provider",
  "issuer",
  "service",
  "software",
  "bank",
  "registrar",
  "engine",
];

export function toSummary(i: ItemWithSummary): VaultItemSummary {
  const def = getItemType(i.type);
  const subtitle =
    i.type === "CREDIT_CARD"
      ? i.cardLast4
        ? `${i.cardBrand ?? "Card"} •••• ${i.cardLast4}`
        : null
      : def?.subtitleField === "username"
        ? i.username
        : def?.subtitleField === "host"
          ? i.host
          : (i.provider ?? i.username ?? i.host);
  return {
    id: i.id,
    type: i.type,
    name: i.name,
    description: i.description,
    subtitle: subtitle ?? i.username ?? i.host ?? null,
    host: i.host,
    username: i.username,
    provider: i.provider,
    environment: i.environment,
    status: i.status,
    favorite: i.favorite,
    project: i.project,
    collection: i.collection,
    tags: i.tags.map((t) => t.tag.name).sort(),
    hasTotp: i.hasTotp,
    passwordStrength: i.passwordStrength,
    cardLast4: i.cardLast4,
    cardBrand: i.cardBrand,
    expiresAt: i.expiresAt?.toISOString() ?? null,
    lastRotatedAt: i.lastRotatedAt?.toISOString() ?? null,
    passwordUpdatedAt: i.passwordUpdatedAt?.toISOString() ?? null,
    lastAccessedAt: i.lastAccessedAt?.toISOString() ?? null,
    accessCount: i.accessCount,
    revision: i.revision,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    deletedAt: i.deletedAt?.toISOString() ?? null,
  };
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface ValidatedField {
  key: string;
  value: string;
  sensitive: boolean;
  label: string | null;
  kind: string | null;
  position: number;
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly findings: FindingsStore,
  ) {}

  /**
   * The encryption boundary on the server side. A registry field's
   * sensitivity comes from the registry, not from the client, and a sensitive
   * value must be an envelope. Plaintext secrets are refused, not stored.
   */
  validateFields(type: string, fields: ItemFieldDto[]): ValidatedField[] {
    const def = getItemType(type);
    if (!def) throw new BadRequestException(`Unknown item type`);
    const seen = new Set<string>();
    return fields
      .filter((f) => f.value !== "")
      .map((f, position) => {
        if (seen.has(f.key)) throw new BadRequestException(`Duplicate field`);
        seen.add(f.key);
        const resolved = resolveField(
          type,
          f.key,
          f.label ? { label: f.label, sensitive: f.sensitive } : undefined,
        );
        if (!resolved) throw new BadRequestException(`Field is not valid for this item type`);
        const sensitive = resolved.def.sensitive;
        if (sensitive && !isEnvelope(f.value)) {
          throw new BadRequestException({
            message: "Sensitive fields must be encrypted on the client",
            code: "PLAINTEXT_SECRET",
          });
        }
        if (!sensitive && f.value.length > 4000) throw new BadRequestException("Field is too long");
        return {
          key: f.key,
          value: f.value,
          sensitive,
          label: resolved.custom ? resolved.def.label : null,
          kind: f.key.startsWith(CUSTOM_FIELD_PREFIX) ? (f.kind ?? "text") : null,
          position,
        };
      });
  }

  /** Columns the server derives itself from the plaintext (non-sensitive) fields. */
  private derive(
    type: string,
    name: string,
    description: string | null | undefined,
    fields: ValidatedField[],
  ) {
    const plain = new Map(fields.filter((f) => !f.sensitive).map((f) => [f.key, f.value]));
    const first = (keys: string[]) =>
      keys
        .map((k) => plain.get(k))
        .find((v) => v?.trim())
        ?.trim() ?? null;
    const def = getItemType(type)!;

    let host = HOST_FIELDS.map((k) => normalizeHost(plain.get(k))).find(Boolean) ?? null;
    if (!host && (type === "SERVER" || type === "DATABASE"))
      host = plain.get("host")?.trim().toLowerCase() || null;
    if (!host && type === "DOMAIN") host = normalizeHost(plain.get("domain"));

    const username = first(USERNAME_FIELDS);
    const provider = first(PROVIDER_FIELDS);
    const environment = plain.get("environment") ?? null;
    const status = plain.get("status") ?? null;
    const hasTotp = fields.some((f) => f.key === "totp");
    const expiresAt = parseDate(plain.get("expires_at"));
    const lastRotatedAt = parseDate(plain.get("last_rotated"));
    const searchText = [
      name,
      description,
      host,
      username,
      provider,
      environment,
      def.label,
      plain.get("domain"),
      plain.get("host"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .slice(0, 2000);
    return {
      host,
      username,
      provider,
      environment,
      status,
      hasTotp,
      expiresAt,
      lastRotatedAt,
      searchText,
    };
  }

  private async assertOwnedRefs(
    vaultId: string,
    projectId?: string | null,
    collectionId?: string | null,
    usedBy?: string[],
  ) {
    if (projectId && !(await this.prisma.project.findFirst({ where: { id: projectId, vaultId } })))
      throw new BadRequestException("Unknown project");
    if (
      collectionId &&
      !(await this.prisma.collection.findFirst({ where: { id: collectionId, vaultId } }))
    )
      throw new BadRequestException("Unknown collection");
    if (usedBy?.length) {
      const count = await this.prisma.project.count({ where: { id: { in: usedBy }, vaultId } });
      if (count !== new Set(usedBy).size) throw new BadRequestException("Unknown project");
    }
  }

  private async tagIds(
    tx: Prisma.TransactionClient,
    vaultId: string,
    names: string[],
  ): Promise<string[]> {
    const clean = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
    const ids: string[] = [];
    for (const name of clean) {
      const tag = await tx.tag.upsert({
        where: { vaultId_name: { vaultId, name } },
        create: { vaultId, name },
        update: {},
      });
      ids.push(tag.id);
    }
    return ids;
  }

  private async findOwned(vaultId: string, id: string) {
    const item = await this.prisma.vaultItem.findFirst({ where: { id, vaultId } });
    if (!item) throw new NotFoundException();
    return item;
  }

  async create(
    auth: AuthContext,
    dto: UpsertItemDto,
    opts: { log?: boolean; tx?: Prisma.TransactionClient } = {},
  ) {
    const fields = this.validateFields(dto.type, dto.fields);
    await this.assertOwnedRefs(auth.vaultId, dto.projectId, dto.collectionId, dto.usedByProjectIds);
    if (await this.prisma.vaultItem.findUnique({ where: { id: dto.id }, select: { id: true } })) {
      throw new ConflictException("Item id already exists");
    }
    const derived = this.derive(dto.type, dto.name, dto.description, fields);
    const def = getItemType(dto.type)!;
    const hasPassword = !!def.passwordField && fields.some((f) => f.key === def.passwordField);
    const run = async (tx: Prisma.TransactionClient) => {
      const tagIds = await this.tagIds(tx, auth.vaultId, dto.tags ?? []);
      return tx.vaultItem.create({
        data: {
          id: dto.id,
          vaultId: auth.vaultId,
          type: dto.type,
          name: dto.name.trim(),
          description: dto.description ?? null,
          projectId: dto.projectId ?? null,
          collectionId: dto.collectionId ?? null,
          favorite: dto.favorite ?? false,
          ...derived,
          passwordStrength: hasPassword ? (dto.signals?.passwordStrength ?? null) : null,
          passwordFingerprint: hasPassword ? (dto.signals?.passwordFingerprint ?? null) : null,
          passwordUpdatedAt: hasPassword ? new Date() : null,
          lastRotatedAt:
            derived.lastRotatedAt ?? (hasPassword && def.category === "secret" ? new Date() : null),
          cardLast4: dto.type === "CREDIT_CARD" ? (dto.signals?.cardLast4 ?? null) : null,
          cardBrand: dto.type === "CREDIT_CARD" ? (dto.signals?.cardBrand ?? null) : null,
          fields: { create: fields },
          tags: { create: tagIds.map((tagId) => ({ tagId })) },
          usedBy: {
            create: [...new Set(dto.usedByProjectIds ?? [])].map((projectId) => ({ projectId })),
          },
        },
        include: SUMMARY_INCLUDE,
      });
    };
    const item = opts.tx ? await run(opts.tx) : await this.prisma.$transaction(run);
    if (opts.log !== false) await this.activity.log(auth, "item.created", { item });
    await this.findings.markDirty(auth.vaultId);
    return toSummary(item);
  }

  async update(
    auth: AuthContext,
    id: string,
    dto: UpsertItemDto,
    opts: { tx?: Prisma.TransactionClient } = {},
  ) {
    if (dto.id !== id) throw new BadRequestException("Id mismatch");
    const existing = await this.prisma.vaultItem.findFirst({
      where: { id, vaultId: auth.vaultId },
      include: { fields: true },
    });
    if (!existing) throw new NotFoundException();
    if (existing.type !== dto.type) throw new BadRequestException("Item type cannot change");
    if (dto.revision !== undefined && dto.revision !== existing.revision) {
      throw new ConflictException({
        message: "This item changed on another device. Reload and try again.",
        code: "REVISION_CONFLICT",
      });
    }
    const fields = this.validateFields(dto.type, dto.fields);
    await this.assertOwnedRefs(auth.vaultId, dto.projectId, dto.collectionId, dto.usedByProjectIds);

    const before = new Map(existing.fields.map((f) => [f.key, f]));
    const after = new Map(fields.map((f) => [f.key, f]));
    const changedKeys = [...new Set([...before.keys(), ...after.keys()])].filter(
      (k) => before.get(k)?.value !== after.get(k)?.value,
    );
    const def = getItemType(dto.type)!;
    const pwKey = def.passwordField;
    const passwordChanged = !!pwKey && changedKeys.includes(pwKey);
    const hasPassword = !!pwKey && after.has(pwKey);
    const derived = this.derive(dto.type, dto.name, dto.description, fields);

    const run = async (tx: Prisma.TransactionClient) => {
      if (changedKeys.length) {
        // Keep the previous values of whatever changed, still encrypted.
        const snapshot = changedKeys
          .map((k) => before.get(k))
          .filter((f): f is NonNullable<typeof f> => !!f)
          .map(({ key, value, sensitive, label, kind }) => ({
            key,
            value,
            sensitive,
            label,
            kind,
          }));
        await tx.vaultItemVersion.create({
          data: { itemId: id, revision: existing.revision, fields: snapshot, changedKeys },
        });
      }
      await tx.vaultItemField.deleteMany({ where: { itemId: id } });
      await tx.vaultItemTag.deleteMany({ where: { itemId: id } });
      await tx.itemProjectLink.deleteMany({ where: { itemId: id } });
      const tagIds = await this.tagIds(tx, auth.vaultId, dto.tags ?? []);
      return tx.vaultItem.update({
        where: { id },
        data: {
          name: dto.name.trim(),
          description: dto.description ?? null,
          projectId: dto.projectId ?? null,
          collectionId: dto.collectionId ?? null,
          favorite: dto.favorite ?? existing.favorite,
          ...derived,
          passwordStrength: hasPassword
            ? passwordChanged
              ? (dto.signals?.passwordStrength ?? null)
              : (dto.signals?.passwordStrength ?? existing.passwordStrength)
            : null,
          passwordFingerprint: hasPassword
            ? passwordChanged
              ? (dto.signals?.passwordFingerprint ?? null)
              : (dto.signals?.passwordFingerprint ?? existing.passwordFingerprint)
            : null,
          passwordUpdatedAt: hasPassword
            ? passwordChanged
              ? new Date()
              : existing.passwordUpdatedAt
            : null,
          lastRotatedAt:
            derived.lastRotatedAt ??
            (passwordChanged && def.category === "secret" ? new Date() : existing.lastRotatedAt),
          cardLast4:
            dto.type === "CREDIT_CARD" ? (dto.signals?.cardLast4 ?? existing.cardLast4) : null,
          cardBrand:
            dto.type === "CREDIT_CARD" ? (dto.signals?.cardBrand ?? existing.cardBrand) : null,
          revision: { increment: 1 },
          fields: { create: fields },
          tags: { create: tagIds.map((tagId) => ({ tagId })) },
          usedBy: {
            create: [...new Set(dto.usedByProjectIds ?? [])].map((projectId) => ({ projectId })),
          },
        },
        include: SUMMARY_INCLUDE,
      });
    };
    const item = opts.tx ? await run(opts.tx) : await this.prisma.$transaction(run);
    await this.activity.log(auth, "item.updated", {
      item,
      metadata: { count: changedKeys.length, revision: item.revision },
    });
    await this.findings.markDirty(auth.vaultId);
    return toSummary(item);
  }

  /** Organising changes that do not touch encrypted fields. */
  async patch(auth: AuthContext, id: string, dto: PatchItemDto) {
    const existing = await this.prisma.vaultItem.findFirst({
      where: { id, vaultId: auth.vaultId },
      include: { fields: true },
    });
    if (!existing) throw new NotFoundException();
    await this.assertOwnedRefs(auth.vaultId, dto.projectId, dto.collectionId);
    const item = await this.prisma.$transaction(async (tx) => {
      if (dto.tags) {
        await tx.vaultItemTag.deleteMany({ where: { itemId: id } });
        const tagIds = await this.tagIds(tx, auth.vaultId, dto.tags);
        await tx.vaultItemTag.createMany({ data: tagIds.map((tagId) => ({ itemId: id, tagId })) });
      }
      const name = dto.name?.trim();
      return tx.vaultItem.update({
        where: { id },
        data: {
          ...(dto.favorite !== undefined ? { favorite: dto.favorite } : {}),
          ...(dto.projectId !== undefined ? { projectId: dto.projectId } : {}),
          ...(dto.collectionId !== undefined ? { collectionId: dto.collectionId } : {}),
          ...(name
            ? {
                name,
                searchText: this.derive(existing.type, name, existing.description, existing.fields)
                  .searchText,
              }
            : {}),
        },
        include: SUMMARY_INCLUDE,
      });
    });
    await this.findings.markDirty(auth.vaultId);
    return toSummary(item);
  }

  async get(auth: AuthContext, id: string, opts: { log?: boolean } = {}): Promise<VaultItemDetail> {
    const item = await this.prisma.vaultItem.findFirst({
      where: { id, vaultId: auth.vaultId },
      include: {
        ...SUMMARY_INCLUDE,
        fields: { orderBy: { position: "asc" } },
        usedBy: { include: { project: { select: { id: true, name: true, color: true } } } },
        relationsFrom: { include: { to: { include: SUMMARY_INCLUDE } } },
        relationsTo: { include: { from: { include: SUMMARY_INCLUDE } } },
        _count: { select: { versions: true } },
      },
    });
    if (!item) throw new NotFoundException();
    await this.prisma.vaultItem.update({ where: { id }, data: { lastAccessedAt: new Date() } });
    if (opts.log !== false) await this.activity.log(auth, "item.viewed", { item });
    const brief = (i: ItemWithSummary) => {
      const s = toSummary(i);
      return { id: s.id, name: s.name, type: s.type, subtitle: s.subtitle };
    };
    return {
      ...toSummary(item),
      fields: item.fields.map(
        (f): ItemField => ({
          key: f.key,
          value: f.value,
          sensitive: f.sensitive,
          ...(f.label ? { label: f.label } : {}),
          ...(f.kind ? { kind: f.kind as ItemField["kind"] } : {}),
        }),
      ),
      usedBy: item.usedBy.map((u) => u.project),
      relations: [
        ...item.relationsFrom
          .filter((r) => !r.to.deletedAt)
          .map((r) => ({
            id: r.id,
            kind: r.kind as RelationKind,
            direction: "outgoing" as const,
            item: brief(r.to),
          })),
        ...item.relationsTo
          .filter((r) => !r.from.deletedAt)
          .map((r) => ({
            id: r.id,
            kind: r.kind as RelationKind,
            direction: "incoming" as const,
            item: brief(r.from),
          })),
      ],
      versionCount: item._count.versions,
    };
  }

  /** `scope` narrows the result further; the workspace module passes its access rule here. */
  async list(
    auth: AuthContext,
    q: ListItemsQuery,
    scope?: Prisma.VaultItemWhereInput,
  ): Promise<Page<VaultItemSummary>> {
    const limit = q.limit ?? 50;
    const and: Prisma.VaultItemWhereInput[] = [];
    const terms = (q.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    for (const term of terms) {
      and.push({
        OR: [
          { searchText: { contains: term, mode: "insensitive" } },
          { project: { name: { contains: term, mode: "insensitive" } } },
          { collection: { name: { contains: term, mode: "insensitive" } } },
          { tags: { some: { tag: { name: { contains: term, mode: "insensitive" } } } } },
        ],
      });
    }
    const types = q.types
      ? q.types.split(",").filter(Boolean)
      : q.category
        ? typesInCategory(q.category as ItemCategory)
        : undefined;
    const where: Prisma.VaultItemWhereInput = {
      vaultId: auth.vaultId,
      deletedAt: q.trash === "true" ? { not: null } : null,
      ...(types ? { type: { in: types } } : {}),
      ...(q.projectId
        ? { OR: [{ projectId: q.projectId }, { usedBy: { some: { projectId: q.projectId } } }] }
        : {}),
      ...(q.collectionId ? { collectionId: q.collectionId } : {}),
      ...(q.tag ? { tags: { some: { tag: { name: q.tag.toLowerCase() } } } } : {}),
      ...(q.favorite === "true" ? { favorite: true } : {}),
      ...(and.length || scope ? { AND: [...and, ...(scope ? [scope] : [])] } : {}),
    };
    const orderBy: Prisma.VaultItemOrderByWithRelationInput[] =
      q.sort === "name"
        ? [{ name: "asc" }, { id: "asc" }]
        : q.sort === "recent"
          ? [{ lastAccessedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }]
          : q.sort === "frequent"
            ? [{ accessCount: "desc" }, { id: "asc" }]
            : q.sort === "created"
              ? [{ createdAt: "desc" }, { id: "asc" }]
              : [{ updatedAt: "desc" }, { id: "asc" }];
    const [rows, total] = await Promise.all([
      this.prisma.vaultItem.findMany({
        where,
        orderBy,
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        include: SUMMARY_INCLUDE,
      }),
      q.cursor ? Promise.resolve(undefined) : this.prisma.vaultItem.count({ where }),
    ]);
    const page = rows.slice(0, limit);
    return {
      items: page.map(toSummary),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
      total,
    };
  }

  /** Logins for the site the extension is on: exact host first, then same registrable domain. */
  /**
   * The most-used values of each non-secret field of a type, across the
   * vault (an email or registrar typed once is offered everywhere). Only
   * plaintext columns are read; sensitive fields are never considered.
   */
  async suggestions(
    auth: AuthContext,
    type: string,
  ): Promise<Record<string, { value: string; count: number }[]>> {
    const def = getItemType(type);
    if (!def) throw new BadRequestException("Unknown item type");
    const keys = def.fields
      .filter(
        (f) =>
          !f.sensitive &&
          ["text", "url", "email", "username", "select", "number"].includes(f.kind) &&
          f.key !== "domain",
      )
      .map((f) => f.key);
    if (!keys.length) return {};
    const rows = await this.prisma.$queryRaw<{ key: string; value: string; n: bigint }[]>`
      SELECT key, value, n FROM (
        SELECT f.key, f.value, COUNT(*) AS n,
               ROW_NUMBER() OVER (PARTITION BY f.key ORDER BY COUNT(*) DESC, MAX(i."updatedAt") DESC) AS rn
        FROM vault_item_fields f
        JOIN vault_items i ON i.id = f."itemId"
        WHERE i."vaultId" = ${auth.vaultId}::uuid AND i."deletedAt" IS NULL
          AND f.sensitive = false AND f.key = ANY(${keys}) AND length(f.value) <= 200
        GROUP BY f.key, f.value
      ) t WHERE rn <= 6`;
    const out: Record<string, { value: string; count: number }[]> = {};
    for (const r of rows) {
      out[r.key] ??= [];
      out[r.key]!.push({ value: r.value, count: Number(r.n) });
    }
    return out;
  }

  async totpItems(auth: AuthContext) {
    const rows = await this.prisma.vaultItemField.findMany({
      where: { key: "totp", item: { vaultId: auth.vaultId, deletedAt: null } },
      select: {
        value: true,
        sensitive: true,
        item: {
          select: {
            id: true,
            name: true,
            type: true,
            username: true,
            provider: true,
            host: true,
            favorite: true,
          },
        },
      },
      orderBy: { item: { name: "asc" } },
      take: 1000,
    });
    return rows.map((r) => ({
      id: r.item.id,
      name: r.item.name,
      type: r.item.type,
      subtitle: r.item.username ?? r.item.provider ?? r.item.host,
      favorite: r.item.favorite,
      field: { key: "totp", value: r.value, sensitive: r.sensitive },
    }));
  }

  async match(auth: AuthContext, host: string): Promise<VaultItemSummary[]> {
    const clean = normalizeHost(host);
    if (!clean) return [];
    // Public-suffix aware: on evil.co.uk this must not widen to every *.co.uk.
    // IPs and localhost match only exactly.
    const domain = registrableDomain(clean);
    const sameSite: Prisma.VaultItemWhereInput[] = domain
      ? [{ host: clean }, { host: domain }, { host: { endsWith: `.${domain}` } }]
      : [{ host: clean }];
    const rows = await this.prisma.vaultItem.findMany({
      where: { vaultId: auth.vaultId, deletedAt: null, OR: sameSite },
      include: SUMMARY_INCLUDE,
      orderBy: [{ lastAccessedAt: { sort: "desc", nulls: "last" } }],
      take: 20,
    });
    // The SQL prefilter is coarse; the shared matcher has the final say.
    return rows
      .map(toSummary)
      .filter((i) => matchHost(i.host, clean) !== null)
      .sort((a, b) => Number(b.host === clean) - Number(a.host === clean));
  }

  async recordUsage(auth: AuthContext, id: string, action: Action, field?: string) {
    const item = await this.findOwned(auth.vaultId, id);
    await this.prisma.vaultItem.update({
      where: { id },
      data: { lastAccessedAt: new Date(), accessCount: { increment: 1 } },
    });
    await this.activity.log(auth, action, { item, metadata: field ? { field } : undefined });
    const lastUse = (item.lastAccessedAt ?? item.createdAt).getTime();
    if (Date.now() - lastUse > 180 * 86_400_000) await this.findings.markDirty(auth.vaultId);
  }

  async remove(auth: AuthContext, id: string) {
    const item = await this.findOwned(auth.vaultId, id);
    if (item.deletedAt) return;
    await this.prisma.vaultItem.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.activity.log(auth, "item.deleted", { item });
    await this.findings.markDirty(auth.vaultId);
  }

  async restore(auth: AuthContext, id: string) {
    const item = await this.findOwned(auth.vaultId, id);
    await this.prisma.vaultItem.update({ where: { id }, data: { deletedAt: null } });
    await this.activity.log(auth, "item.restored", { item });
    await this.findings.markDirty(auth.vaultId);
  }

  /** Permanent deletion, only from the trash. */
  async purge(auth: AuthContext, id: string) {
    const item = await this.findOwned(auth.vaultId, id);
    if (!item.deletedAt) throw new BadRequestException("Move the item to the trash first");
    await this.prisma.vaultItem.delete({ where: { id } });
    await this.activity.log(auth, "item.purged", { item });
    await this.findings.markDirty(auth.vaultId);
  }

  async versions(auth: AuthContext, id: string): Promise<ItemVersion[]> {
    const item = await this.findOwned(auth.vaultId, id);
    const rows = await this.prisma.vaultItemVersion.findMany({
      where: { itemId: id },
      orderBy: { revision: "desc" },
      take: 50,
    });
    await this.activity.log(auth, "item.version_viewed", { item });
    return rows.map((v) => ({
      id: v.id,
      revision: v.revision,
      createdAt: v.createdAt.toISOString(),
      changedKeys: v.changedKeys,
      fields: v.fields as unknown as ItemField[],
    }));
  }

  /**
   * Folds duplicates into one canonical item. The client has already written
   * whatever it wanted to keep into the target; here the sources go to the
   * trash and everything that pointed at them points at the target.
   */
  async merge(auth: AuthContext, targetId: string, sourceIds: string[]) {
    const target = await this.findOwned(auth.vaultId, targetId);
    const ids = [...new Set(sourceIds)].filter((s) => s !== targetId);
    const sources = await this.prisma.vaultItem.findMany({
      where: { id: { in: ids }, vaultId: auth.vaultId },
    });
    if (sources.length !== ids.length) throw new NotFoundException();
    await this.prisma.$transaction(async (tx) => {
      const rels = await tx.vaultItemRelation.findMany({
        where: { OR: [{ fromItemId: { in: ids } }, { toItemId: { in: ids } }] },
      });
      for (const r of rels) {
        const from = ids.includes(r.fromItemId) ? targetId : r.fromItemId;
        const to = ids.includes(r.toItemId) ? targetId : r.toItemId;
        await tx.vaultItemRelation.delete({ where: { id: r.id } });
        if (from !== to) {
          await tx.vaultItemRelation.upsert({
            where: { fromItemId_toItemId_kind: { fromItemId: from, toItemId: to, kind: r.kind } },
            create: { fromItemId: from, toItemId: to, kind: r.kind },
            update: {},
          });
        }
      }
      const links = await tx.itemProjectLink.findMany({ where: { itemId: { in: ids } } });
      for (const l of links) {
        await tx.itemProjectLink.upsert({
          where: { itemId_projectId: { itemId: targetId, projectId: l.projectId } },
          create: { itemId: targetId, projectId: l.projectId },
          update: {},
        });
      }
      await tx.vaultItem.updateMany({
        where: { id: { in: ids } },
        data: { deletedAt: new Date() },
      });
    });
    for (const s of sources)
      await this.activity.log(auth, "item.merged", {
        item: s,
        metadata: { mergedInto: target.id },
      });
    await this.findings.markDirty(auth.vaultId);
    return { merged: ids.length };
  }
}
