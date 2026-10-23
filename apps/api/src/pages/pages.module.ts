import {
  isEncryptedBlob,
  isEnvelope,
  type PageDetail,
  type PageNode,
  type PageVersion,
} from "@minions/core";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import type { Response } from "express";
import { ActivityService } from "../activity/activity.service";
import { Auth, type AuthContext } from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import { PrismaService } from "../common/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { PAGE_BATCH_MAX, PAGE_CONTENT_MAX, PAGE_FILE_MAX_BYTES } from "./limits";

/**
 * Notion-style pages (docs/NOTION_ALTERNATIVE_PLAN.md). The server stores a
 * tree of ciphertext: every page key arrives wrapped by the vault key, and
 * titles, content and files arrive encrypted under the page key. It checks
 * shapes (every secret must be an envelope), ownership (every row is looked
 * up with the session's vault) and the tree (no cycles, parents in the same
 * vault), and never sees a title or a word of content.
 */

const VERSION_INTERVAL_MS = 10 * 60_000;
// Fractional-index keys are short base-62 strings.
const POSITION = /^[0-9A-Za-z]{1,128}$/;

class CreatePageDto {
  @IsUUID(4) id!: string;
  @IsOptional() @IsUUID(4) parentId?: string | null;
  @Matches(POSITION) position!: string;
  @IsIn(["page", "database"]) kind!: "page" | "database";
  @IsString() @MaxLength(200) protectedKey!: string;
  @IsString() @MaxLength(65_536) metaEnc!: string;
  @IsOptional() @IsString() @MaxLength(PAGE_CONTENT_MAX) contentEnc?: string | null;
  @IsOptional() @IsBoolean() favorite?: boolean;
}

class BatchCreateDto {
  @IsArray()
  @ArrayMaxSize(PAGE_BATCH_MAX)
  @ValidateNested({ each: true })
  @Type(() => CreatePageDto)
  pages!: CreatePageDto[];
}

class UpdatePageDto {
  @IsString() @MaxLength(65_536) metaEnc!: string;
  @IsOptional() @IsString() @MaxLength(PAGE_CONTENT_MAX) contentEnc?: string | null;
  @IsOptional() @IsInt() @Min(1) revision?: number;
}

class MovePageDto {
  /** Undefined: stay; null: move to the top level. */
  @IsOptional() @IsUUID(4) parentId?: string | null;
  @IsOptional() @Matches(POSITION) position?: string;
  @IsOptional() @IsBoolean() favorite?: boolean;
}

class TreeQuery {
  @IsOptional() @IsIn(["active", "trash"]) view?: "active" | "trash";
}

const NODE_SELECT = {
  id: true,
  parentId: true,
  position: true,
  kind: true,
  protectedKey: true,
  metaEnc: true,
  favorite: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.PageSelect;

type NodeRow = Prisma.PageGetPayload<{ select: typeof NODE_SELECT }>;

function node(p: NodeRow): PageNode {
  return {
    id: p.id,
    parentId: p.parentId,
    position: p.position,
    kind: p.kind as PageNode["kind"],
    protectedKey: p.protectedKey,
    metaEnc: p.metaEnc,
    favorite: p.favorite,
    revision: p.revision,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    deletedAt: p.deletedAt?.toISOString() ?? null,
  };
}

function plaintextRefused(): never {
  throw new BadRequestException({
    message: "Pages must be encrypted on the client",
    code: "PLAINTEXT_SECRET",
  });
}

/** Every value a person wrote must arrive as an envelope. */
function assertEncrypted(v: {
  protectedKey?: string;
  metaEnc?: string;
  contentEnc?: string | null;
}) {
  if (v.protectedKey !== undefined && !isEnvelope(v.protectedKey)) plaintextRefused();
  if (v.metaEnc !== undefined && !isEnvelope(v.metaEnc)) plaintextRefused();
  if (v.contentEnc != null && !isEnvelope(v.contentEnc)) plaintextRefused();
}

@Injectable()
export class PagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  private async owned(vaultId: string, id: string) {
    const page = await this.prisma.page.findFirst({ where: { id, vaultId } });
    if (!page) throw new NotFoundException();
    return page;
  }

  private async assertParent(vaultId: string, parentId: string) {
    const parent = await this.prisma.page.findFirst({
      where: { id: parentId, vaultId },
      select: { deletedAt: true },
    });
    if (!parent) throw new BadRequestException("Unknown parent page");
    if (parent.deletedAt) throw new BadRequestException("The parent page is in the trash");
  }

  /**
   * Ids of a page and everything under it, in one query. `live`: only through
   * pages not in the trash (a sub-page trashed earlier keeps its own group).
   */
  private async subtree(
    vaultId: string,
    rootId: string,
    live: boolean,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE tree AS (
        SELECT id FROM pages WHERE id = ${rootId}::uuid AND "vaultId" = ${vaultId}::uuid
        UNION ALL
        SELECT p.id FROM pages p JOIN tree t ON p."parentId" = t.id
        WHERE p."vaultId" = ${vaultId}::uuid AND (NOT ${live} OR p."deletedAt" IS NULL)
      )
      SELECT id FROM tree`;
    return rows.map((r) => r.id);
  }

  async tree(auth: AuthContext, q: TreeQuery): Promise<{ pages: PageNode[] }> {
    const rows = await this.prisma.page.findMany({
      where: { vaultId: auth.vaultId, deletedAt: q.view === "trash" ? { not: null } : null },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: NODE_SELECT,
    });
    return { pages: rows.map(node) };
  }

  async get(auth: AuthContext, id: string): Promise<PageDetail> {
    const page = await this.prisma.page.findFirst({
      where: { id, vaultId: auth.vaultId },
      select: { ...NODE_SELECT, contentEnc: true },
    });
    if (!page) throw new NotFoundException();
    return { ...node(page), contentEnc: page.contentEnc };
  }

  async create(auth: AuthContext, dto: CreatePageDto): Promise<PageDetail> {
    assertEncrypted(dto);
    if (dto.parentId) await this.assertParent(auth.vaultId, dto.parentId);
    if (await this.prisma.page.findUnique({ where: { id: dto.id }, select: { id: true } }))
      throw new ConflictException("Page id already exists");
    await this.prisma.page.create({ data: this.row(auth, dto) });
    await this.activity.log(auth, "page.created", {
      item: { id: dto.id, name: "Encrypted page", type: "PAGE" },
    });
    return this.get(auth, dto.id);
  }

  private row(auth: AuthContext, dto: CreatePageDto): Prisma.PageCreateManyInput {
    return {
      id: dto.id,
      vaultId: auth.vaultId,
      parentId: dto.parentId ?? null,
      position: dto.position,
      kind: dto.kind,
      protectedKey: dto.protectedKey,
      metaEnc: dto.metaEnc,
      contentEnc: dto.contentEnc ?? null,
      favorite: dto.favorite ?? false,
    };
  }

  /**
   * Many pages at once (imports). Parents may be earlier in the same batch.
   * Ids already in this vault are skipped, so a retried batch is harmless.
   */
  async createMany(auth: AuthContext, dto: BatchCreateDto) {
    for (const p of dto.pages) assertEncrypted(p);
    const ids = dto.pages.map((p) => p.id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException("Duplicate page ids");
    const existing = await this.prisma.page.findMany({
      where: { id: { in: ids } },
      select: { id: true, vaultId: true },
    });
    if (existing.some((e) => e.vaultId !== auth.vaultId))
      throw new ConflictException("Page id already exists");
    const skip = new Set(existing.map((e) => e.id));

    const outside = [
      ...new Set(
        dto.pages.map((p) => p.parentId).filter((id): id is string => !!id && !ids.includes(id)),
      ),
    ];
    const parents = await this.prisma.page.findMany({
      where: { id: { in: outside }, vaultId: auth.vaultId, deletedAt: null },
      select: { id: true },
    });
    const known = new Set([...parents.map((p) => p.id), ...skip]);
    const fresh: Prisma.PageCreateManyInput[] = [];
    for (const p of dto.pages) {
      if (p.parentId && !known.has(p.parentId))
        throw new BadRequestException("Unknown parent page");
      known.add(p.id);
      if (!skip.has(p.id)) fresh.push(this.row(auth, p));
    }
    if (fresh.length) await this.prisma.page.createMany({ data: fresh });
    if (fresh.length)
      await this.activity.log(auth, "pages.imported", { metadata: { count: fresh.length } });
    return { created: fresh.length, skipped: skip.size };
  }

  async update(auth: AuthContext, id: string, dto: UpdatePageDto): Promise<PageDetail> {
    assertEncrypted(dto);
    const existing = await this.owned(auth.vaultId, id);
    if (existing.deletedAt) throw new BadRequestException("Restore the page to edit it");
    if (dto.revision !== undefined && dto.revision !== existing.revision)
      throw new ConflictException({
        message: "This page changed elsewhere. Reload to see the latest version.",
        code: "REVISION_CONFLICT",
      });
    const contentEnc = dto.contentEnc ?? null;
    const changed = contentEnc !== existing.contentEnc || dto.metaEnc !== existing.metaEnc;
    if (!changed) return this.get(auth, id);
    await this.prisma.$transaction(async (tx) => {
      // Autosave writes often; keep a version at most every ten minutes.
      const last = await tx.pageVersion.findFirst({
        where: { pageId: id },
        orderBy: { revision: "desc" },
        select: { createdAt: true },
      });
      if (!last || Date.now() - last.createdAt.getTime() > VERSION_INTERVAL_MS)
        await tx.pageVersion.create({
          data: {
            pageId: id,
            revision: existing.revision,
            metaEnc: existing.metaEnc,
            contentEnc: existing.contentEnc,
          },
        });
      // Conditional on the revision read above: two racing saves cannot both win.
      const r = await tx.page.updateMany({
        where: { id, vaultId: auth.vaultId, revision: existing.revision },
        data: { metaEnc: dto.metaEnc, contentEnc, revision: { increment: 1 } },
      });
      if (r.count !== 1)
        throw new ConflictException({
          message: "This page changed elsewhere. Reload to see the latest version.",
          code: "REVISION_CONFLICT",
        });
    });
    return this.get(auth, id);
  }

  async move(auth: AuthContext, id: string, dto: MovePageDto): Promise<PageNode> {
    const page = await this.owned(auth.vaultId, id);
    if (dto.parentId !== undefined && dto.parentId !== page.parentId) {
      if (page.deletedAt) throw new BadRequestException("Restore the page to move it");
      if (dto.parentId) {
        if (dto.parentId === id) throw new BadRequestException("A page cannot contain itself");
        await this.assertParent(auth.vaultId, dto.parentId);
        // The new parent must not be inside the page being moved.
        if ((await this.subtree(auth.vaultId, id, true)).includes(dto.parentId))
          throw new BadRequestException("A page cannot move inside one of its sub-pages");
      }
    }
    const updated = await this.prisma.page.update({
      where: { id },
      data: {
        ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
        ...(dto.favorite !== undefined ? { favorite: dto.favorite } : {}),
      },
      select: NODE_SELECT,
    });
    return node(updated);
  }

  /** Moves a page and everything under it to the trash, as one group. */
  async remove(auth: AuthContext, id: string) {
    const page = await this.owned(auth.vaultId, id);
    if (page.deletedAt) return;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const ids = await this.subtree(auth.vaultId, id, true, tx);
      await tx.page.updateMany({
        where: { id: { in: ids }, vaultId: auth.vaultId },
        data: { deletedAt: now },
      });
    });
    await this.activity.log(auth, "page.deleted", {
      item: { id, name: "Encrypted page", type: "PAGE" },
    });
  }

  /** Brings back the group deleted together with this page. */
  async restore(auth: AuthContext, id: string) {
    const page = await this.owned(auth.vaultId, id);
    if (!page.deletedAt) return;
    const deletedAt = page.deletedAt;
    await this.prisma.$transaction(async (tx) => {
      const ids = await this.subtree(auth.vaultId, id, false, tx);
      await tx.page.updateMany({
        // Only what was trashed in the same instant: not sub-pages trashed earlier.
        where: { id: { in: ids }, vaultId: auth.vaultId, deletedAt },
        data: { deletedAt: null },
      });
      // A page whose parent is still in the trash comes back at the top level.
      if (page.parentId) {
        const parent = await tx.page.findUnique({
          where: { id: page.parentId },
          select: { deletedAt: true },
        });
        if (parent?.deletedAt) await tx.page.update({ where: { id }, data: { parentId: null } });
      }
    });
    await this.activity.log(auth, "page.restored", {
      item: { id, name: "Encrypted page", type: "PAGE" },
    });
  }

  /** Deletes a trashed page, its sub-pages, versions and files for good. */
  async purge(auth: AuthContext, id: string) {
    const page = await this.owned(auth.vaultId, id);
    if (!page.deletedAt) throw new BadRequestException("Move the page to the trash first");
    await this.prisma.page.delete({ where: { id } });
    await this.activity.log(auth, "page.purged", {
      item: { id, name: "Encrypted page", type: "PAGE" },
    });
  }

  async versions(auth: AuthContext, id: string): Promise<PageVersion[]> {
    await this.owned(auth.vaultId, id);
    const rows = await this.prisma.pageVersion.findMany({
      where: { pageId: id },
      orderBy: { revision: "desc" },
      take: 50,
    });
    return rows.map((v) => ({
      id: v.id,
      revision: v.revision,
      metaEnc: v.metaEnc,
      contentEnc: v.contentEnc,
      createdAt: v.createdAt.toISOString(),
    }));
  }

  /** Stores one encrypted file. Uploading the same id again is a no-op. */
  async putFile(
    auth: AuthContext,
    pageId: string,
    fileId: string,
    metaEnc: string | undefined,
    data: unknown,
  ) {
    const page = await this.owned(auth.vaultId, pageId);
    if (page.deletedAt) throw new BadRequestException("Restore the page to add files");
    if (!Buffer.isBuffer(data))
      throw new BadRequestException("Send the file as application/octet-stream");
    if (data.length > PAGE_FILE_MAX_BYTES) throw new PayloadTooLargeException();
    if (!metaEnc || metaEnc.length > 4096 || !isEnvelope(metaEnc) || !isEncryptedBlob(data))
      plaintextRefused();
    const existing = await this.prisma.pageFile.findUnique({
      where: { id: fileId },
      select: { pageId: true },
    });
    if (existing) {
      if (existing.pageId !== pageId) throw new ConflictException("File id already exists");
      return;
    }
    await this.prisma.pageFile.create({
      data: {
        id: fileId,
        pageId,
        vaultId: auth.vaultId,
        metaEnc,
        size: data.length,
        data: new Uint8Array(data),
      },
    });
  }

  async getFile(auth: AuthContext, pageId: string, fileId: string) {
    const file = await this.prisma.pageFile.findFirst({
      where: { id: fileId, pageId, vaultId: auth.vaultId },
      select: { data: true, metaEnc: true },
    });
    if (!file) throw new NotFoundException();
    return file;
  }
}

const Id = (name = "id") => Param(name, new ParseUUIDPipe({ version: "4" }));

/** Per client and route, per minute, for import batches and files (the default is 300). */
const IMPORT_RATE = 1200;

@UseGuards(VaultUnlockedGuard)
@Controller("pages")
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Get() tree(@Auth() a: AuthContext, @Query() q: TreeQuery) {
    return this.pages.tree(a, q);
  }
  @Post() create(@Auth() a: AuthContext, @Body() dto: CreatePageDto) {
    return this.pages.create(a, dto);
  }
  // Imports: a large workspace is many batches and many files in a few minutes.
  @Throttle({ default: { limit: IMPORT_RATE, ttl: 60_000 } })
  @Post("batch")
  @HttpCode(200)
  createMany(@Auth() a: AuthContext, @Body() dto: BatchCreateDto) {
    return this.pages.createMany(a, dto);
  }
  @Get(":id") get(@Auth() a: AuthContext, @Id() id: string) {
    return this.pages.get(a, id);
  }
  @Put(":id") update(@Auth() a: AuthContext, @Id() id: string, @Body() dto: UpdatePageDto) {
    return this.pages.update(a, id, dto);
  }
  @Patch(":id") move(@Auth() a: AuthContext, @Id() id: string, @Body() dto: MovePageDto) {
    return this.pages.move(a, id, dto);
  }
  @Delete(":id") @HttpCode(204) async remove(@Auth() a: AuthContext, @Id() id: string) {
    await this.pages.remove(a, id);
  }
  @Post(":id/restore") @HttpCode(204) async restore(@Auth() a: AuthContext, @Id() id: string) {
    await this.pages.restore(a, id);
  }
  @Delete(":id/purge") @HttpCode(204) async purge(@Auth() a: AuthContext, @Id() id: string) {
    await this.pages.purge(a, id);
  }
  @Get(":id/versions") versions(@Auth() a: AuthContext, @Id() id: string) {
    return this.pages.versions(a, id);
  }
  @Throttle({ default: { limit: IMPORT_RATE, ttl: 60_000 } })
  @Put(":id/files/:fileId")
  @HttpCode(204)
  async putFile(
    @Auth() a: AuthContext,
    @Id() id: string,
    @Id("fileId") fileId: string,
    @Headers("x-minions-file-meta") metaEnc: string | undefined,
    @Body() data: unknown,
  ) {
    await this.pages.putFile(a, id, fileId, metaEnc, data);
  }
  // A page full of images loads them all at once.
  @Throttle({ default: { limit: IMPORT_RATE, ttl: 60_000 } })
  @Get(":id/files/:fileId")
  async getFile(
    @Auth() a: AuthContext,
    @Id() id: string,
    @Id("fileId") fileId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.pages.getFile(a, id, fileId);
    // The encrypted {name, type}; ciphertext, like the body.
    res.setHeader("x-minions-file-meta", file.metaEnc);
    return new StreamableFile(Buffer.from(file.data), { type: "application/octet-stream" });
  }
}

@Module({ controllers: [PagesController], providers: [PagesService] })
export class PagesModule {}
