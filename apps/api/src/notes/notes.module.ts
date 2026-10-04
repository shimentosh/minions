import type { NoteDetail, NoteSummary, Page } from "@minions/core";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
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
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { ActivityService } from "../activity/activity.service";
import { Auth, type AuthContext } from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import { PrismaService } from "../common/prisma.service";
import type { Prisma } from "../generated/prisma/client";

// Rich text can be large; 2 MB of ciphertext is roughly 1.5 MB of HTML.
const ENVELOPE = /^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]+={0,2}$/;
const VERSION_INTERVAL_MS = 10 * 60_000;

class UpsertNoteDto {
  @IsUUID(4) id!: string;
  @IsString() @Length(0, 300) title!: string;
  @IsOptional() @Matches(ENVELOPE) @MaxLength(2_000_000) contentEnc?: string | null;
  @IsOptional() @IsUUID(4) projectId?: string | null;
  @IsOptional() @IsUUID(4) collectionId?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  tags?: string[];
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsBoolean() favorite?: boolean;
  @IsOptional() @IsInt() @Min(1) revision?: number;
}

class PatchNoteDto {
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsBoolean() favorite?: boolean;
  @IsOptional() @IsBoolean() archived?: boolean;
  @IsOptional() @IsUUID(4) projectId?: string | null;
  @IsOptional() @IsUUID(4) collectionId?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  tags?: string[];
}

class ListNotesQuery {
  @IsOptional() @IsIn(["all", "favorites", "recent", "archived", "trash"]) view?: string;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsUUID(4) projectId?: string;
  @IsOptional() @IsUUID(4) collectionId?: string;
  @IsOptional() @IsString() @MaxLength(40) tag?: string;
  @IsOptional() @IsString() @MaxLength(60) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

const INCLUDE = {
  project: { select: { id: true, name: true, color: true } },
  collection: { select: { id: true, name: true, color: true } },
  tags: { select: { tag: { select: { name: true } } } },
} satisfies Prisma.NoteInclude;

type NoteRow = Prisma.NoteGetPayload<{ include: typeof INCLUDE }>;

function summary(n: NoteRow): NoteSummary {
  return {
    id: n.id,
    title: n.title,
    pinned: n.pinned,
    favorite: n.favorite,
    archived: !!n.archivedAt,
    project: n.project,
    collection: n.collection,
    tags: n.tags.map((t) => t.tag.name).sort(),
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
    deletedAt: n.deletedAt?.toISOString() ?? null,
    revision: n.revision,
  };
}

@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  private async tagIds(tx: Prisma.TransactionClient, vaultId: string, names: string[]) {
    const ids: string[] = [];
    for (const name of [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))]) {
      ids.push(
        (
          await tx.tag.upsert({
            where: { vaultId_name: { vaultId, name } },
            create: { vaultId, name },
            update: {},
          })
        ).id,
      );
    }
    return ids;
  }

  private async assertRefs(
    vaultId: string,
    projectId?: string | null,
    collectionId?: string | null,
  ) {
    if (projectId && !(await this.prisma.project.findFirst({ where: { id: projectId, vaultId } })))
      throw new BadRequestException("Unknown project");
    if (
      collectionId &&
      !(await this.prisma.collection.findFirst({ where: { id: collectionId, vaultId } }))
    )
      throw new BadRequestException("Unknown collection");
  }

  private async owned(vaultId: string, id: string) {
    const note = await this.prisma.note.findFirst({ where: { id, vaultId } });
    if (!note) throw new NotFoundException();
    return note;
  }

  async list(auth: AuthContext, q: ListNotesQuery): Promise<Page<NoteSummary>> {
    const limit = q.limit ?? 50;
    const view = q.view ?? "all";
    const terms = (q.q ?? "").split(/\s+/).filter(Boolean).slice(0, 6);
    const where: Prisma.NoteWhereInput = {
      vaultId: auth.vaultId,
      deletedAt: view === "trash" ? { not: null } : null,
      ...(view === "archived"
        ? { archivedAt: { not: null } }
        : view === "trash"
          ? {}
          : { archivedAt: null }),
      ...(view === "favorites" ? { favorite: true } : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.collectionId ? { collectionId: q.collectionId } : {}),
      ...(q.tag ? { tags: { some: { tag: { name: q.tag.toLowerCase() } } } } : {}),
      // Bodies are ciphertext; search runs over titles and organisation only.
      ...(terms.length
        ? {
            AND: terms.map((t) => ({
              OR: [
                { title: { contains: t, mode: "insensitive" as const } },
                { project: { name: { contains: t, mode: "insensitive" as const } } },
                { collection: { name: { contains: t, mode: "insensitive" as const } } },
                {
                  tags: { some: { tag: { name: { contains: t, mode: "insensitive" as const } } } },
                },
              ],
            })),
          }
        : {}),
    };
    const orderBy: Prisma.NoteOrderByWithRelationInput[] =
      view === "recent"
        ? [{ updatedAt: "desc" }, { id: "asc" }]
        : [{ pinned: "desc" }, { updatedAt: "desc" }, { id: "asc" }];
    const rows = await this.prisma.note.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: INCLUDE,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(summary),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  async get(auth: AuthContext, id: string): Promise<NoteDetail> {
    const note = await this.prisma.note.findFirst({
      where: { id, vaultId: auth.vaultId },
      include: INCLUDE,
    });
    if (!note) throw new NotFoundException();
    return { ...summary(note), contentEnc: note.contentEnc };
  }

  async create(auth: AuthContext, dto: UpsertNoteDto): Promise<NoteDetail> {
    await this.assertRefs(auth.vaultId, dto.projectId, dto.collectionId);
    if (await this.prisma.note.findUnique({ where: { id: dto.id }, select: { id: true } }))
      throw new ConflictException("Note id already exists");
    const note = await this.prisma.$transaction(async (tx) => {
      const tagIds = await this.tagIds(tx, auth.vaultId, dto.tags ?? []);
      return tx.note.create({
        data: {
          id: dto.id,
          vaultId: auth.vaultId,
          title: dto.title.trim(),
          contentEnc: dto.contentEnc ?? null,
          projectId: dto.projectId ?? null,
          collectionId: dto.collectionId ?? null,
          pinned: dto.pinned ?? false,
          favorite: dto.favorite ?? false,
          tags: { create: tagIds.map((tagId) => ({ tagId })) },
        },
        include: INCLUDE,
      });
    });
    await this.activity.log(auth, "note.created", {
      item: { id: note.id, name: note.title || "Untitled", type: "NOTE" },
    });
    return { ...summary(note), contentEnc: note.contentEnc };
  }

  async update(auth: AuthContext, id: string, dto: UpsertNoteDto): Promise<NoteDetail> {
    if (dto.id !== id) throw new BadRequestException("Id mismatch");
    const existing = await this.owned(auth.vaultId, id);
    if (dto.revision !== undefined && dto.revision !== existing.revision) {
      throw new ConflictException({
        message: "This note changed elsewhere. Reload to see the latest version.",
        code: "REVISION_CONFLICT",
      });
    }
    await this.assertRefs(auth.vaultId, dto.projectId, dto.collectionId);
    const contentChanged =
      (dto.contentEnc ?? null) !== existing.contentEnc || dto.title.trim() !== existing.title;
    const note = await this.prisma.$transaction(async (tx) => {
      if (contentChanged) {
        // Autosave writes often; keep a version at most every ten minutes.
        const last = await tx.noteVersion.findFirst({
          where: { noteId: id },
          orderBy: { revision: "desc" },
        });
        if (!last || Date.now() - last.createdAt.getTime() > VERSION_INTERVAL_MS) {
          await tx.noteVersion.create({
            data: {
              noteId: id,
              revision: existing.revision,
              title: existing.title,
              contentEnc: existing.contentEnc,
            },
          });
        }
      }
      await tx.noteTag.deleteMany({ where: { noteId: id } });
      const tagIds = await this.tagIds(tx, auth.vaultId, dto.tags ?? []);
      return tx.note.update({
        where: { id },
        data: {
          title: dto.title.trim(),
          contentEnc: dto.contentEnc ?? null,
          projectId: dto.projectId ?? null,
          collectionId: dto.collectionId ?? null,
          pinned: dto.pinned ?? existing.pinned,
          favorite: dto.favorite ?? existing.favorite,
          revision: { increment: 1 },
          tags: { create: tagIds.map((tagId) => ({ tagId })) },
        },
        include: INCLUDE,
      });
    });
    if (contentChanged)
      await this.activity.log(auth, "note.updated", {
        item: { id, name: note.title || "Untitled", type: "NOTE" },
      });
    return { ...summary(note), contentEnc: note.contentEnc };
  }

  async patch(auth: AuthContext, id: string, dto: PatchNoteDto): Promise<NoteSummary> {
    await this.owned(auth.vaultId, id);
    await this.assertRefs(auth.vaultId, dto.projectId, dto.collectionId);
    const note = await this.prisma.$transaction(async (tx) => {
      if (dto.tags) {
        await tx.noteTag.deleteMany({ where: { noteId: id } });
        const tagIds = await this.tagIds(tx, auth.vaultId, dto.tags);
        await tx.noteTag.createMany({ data: tagIds.map((tagId) => ({ noteId: id, tagId })) });
      }
      return tx.note.update({
        where: { id },
        data: {
          ...(dto.pinned !== undefined ? { pinned: dto.pinned } : {}),
          ...(dto.favorite !== undefined ? { favorite: dto.favorite } : {}),
          ...(dto.archived !== undefined ? { archivedAt: dto.archived ? new Date() : null } : {}),
          ...(dto.projectId !== undefined ? { projectId: dto.projectId } : {}),
          ...(dto.collectionId !== undefined ? { collectionId: dto.collectionId } : {}),
        },
        include: INCLUDE,
      });
    });
    return summary(note);
  }

  async remove(auth: AuthContext, id: string) {
    const note = await this.owned(auth.vaultId, id);
    await this.prisma.note.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.activity.log(auth, "note.deleted", {
      item: { id, name: note.title || "Untitled", type: "NOTE" },
    });
  }

  async restore(auth: AuthContext, id: string) {
    await this.owned(auth.vaultId, id);
    await this.prisma.note.update({ where: { id }, data: { deletedAt: null } });
  }

  async purge(auth: AuthContext, id: string) {
    const note = await this.owned(auth.vaultId, id);
    if (!note.deletedAt) throw new BadRequestException("Move the note to the trash first");
    await this.prisma.note.delete({ where: { id } });
  }

  async versions(auth: AuthContext, id: string) {
    await this.owned(auth.vaultId, id);
    const rows = await this.prisma.noteVersion.findMany({
      where: { noteId: id },
      orderBy: { revision: "desc" },
      take: 50,
    });
    return rows.map((v) => ({
      id: v.id,
      revision: v.revision,
      title: v.title,
      contentEnc: v.contentEnc,
      createdAt: v.createdAt.toISOString(),
    }));
  }
}

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

@UseGuards(VaultUnlockedGuard)
@Controller("notes")
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get() list(@Auth() a: AuthContext, @Query() q: ListNotesQuery) {
    return this.notes.list(a, q);
  }
  @Post() create(@Auth() a: AuthContext, @Body() dto: UpsertNoteDto) {
    return this.notes.create(a, dto);
  }
  @Get(":id") get(@Auth() a: AuthContext, @Id() id: string) {
    return this.notes.get(a, id);
  }
  @Put(":id") update(@Auth() a: AuthContext, @Id() id: string, @Body() dto: UpsertNoteDto) {
    return this.notes.update(a, id, dto);
  }
  @Patch(":id") patch(@Auth() a: AuthContext, @Id() id: string, @Body() dto: PatchNoteDto) {
    return this.notes.patch(a, id, dto);
  }
  @Delete(":id") @HttpCode(204) async remove(@Auth() a: AuthContext, @Id() id: string) {
    await this.notes.remove(a, id);
  }
  @Post(":id/restore") @HttpCode(204) async restore(@Auth() a: AuthContext, @Id() id: string) {
    await this.notes.restore(a, id);
  }
  @Delete(":id/purge") @HttpCode(204) async purge(@Auth() a: AuthContext, @Id() id: string) {
    await this.notes.purge(a, id);
  }
  @Get(":id/versions") versions(@Auth() a: AuthContext, @Id() id: string) {
    return this.notes.versions(a, id);
  }
}

@Module({ controllers: [NotesController], providers: [NotesService] })
export class NotesModule {}
