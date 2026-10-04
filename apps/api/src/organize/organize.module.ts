import { getItemType } from "@minions/core";
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
  UseGuards,
} from "@nestjs/common";
import { Auth, type AuthContext } from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import { PrismaService } from "../common/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { FindingsStore } from "../security/findings-store";
import { GroupDto, RelationDto, RenameTagDto, UpdateGroupDto } from "./organize.dto";

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

function uniqueViolation(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
    throw new ConflictException("That name is already in use");
  throw e;
}

@Injectable()
export class OrganizeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly findings: FindingsStore,
  ) {}

  // ─── Projects ──────────────────────────────────────────────────────────────

  async listProjects(vaultId: string) {
    const rows = await this.prisma.project.findMany({
      where: { vaultId },
      orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { name: "asc" }],
      include: {
        _count: {
          select: {
            items: { where: { deletedAt: null } },
            notes: { where: { deletedAt: null } },
            usedBy: true,
          },
        },
      },
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      color: p.color,
      archived: !!p.archivedAt,
      itemCount: p._count.items + p._count.usedBy,
      noteCount: p._count.notes,
      updatedAt: p.updatedAt,
    }));
  }

  /** A project with its items grouped the way the project page shows them. */
  async getProject(vaultId: string, id: string) {
    const project = await this.prisma.project.findFirst({ where: { id, vaultId } });
    if (!project) throw new NotFoundException();
    const [owned, used, notes] = await Promise.all([
      this.prisma.vaultItem.findMany({
        where: { vaultId, projectId: id, deletedAt: null },
        select: {
          id: true,
          name: true,
          type: true,
          username: true,
          host: true,
          provider: true,
          environment: true,
          favorite: true,
        },
      }),
      this.prisma.vaultItem.findMany({
        where: {
          vaultId,
          deletedAt: null,
          usedBy: { some: { projectId: id } },
          NOT: { projectId: id },
        },
        select: {
          id: true,
          name: true,
          type: true,
          username: true,
          host: true,
          provider: true,
          environment: true,
          favorite: true,
        },
      }),
      this.prisma.note.findMany({
        where: { vaultId, projectId: id, deletedAt: null },
        select: { id: true, title: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 20,
      }),
    ]);
    const shape = (shared: boolean) => (i: (typeof owned)[number]) => ({
      ...i,
      shared,
      category: getItemType(i.type)?.category ?? "other",
      subtitle: i.username ?? i.provider ?? i.host,
    });
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      color: project.color,
      archived: !!project.archivedAt,
      items: [...owned.map(shape(false)), ...used.map(shape(true))],
      notes,
    };
  }

  async createProject(vaultId: string, dto: GroupDto) {
    return this.prisma.project
      .create({
        data: {
          vaultId,
          name: dto.name.trim(),
          description: dto.description ?? null,
          color: dto.color ?? null,
        },
      })
      .catch(uniqueViolation);
  }

  async updateProject(vaultId: string, id: string, dto: UpdateGroupDto) {
    await this.ownedProject(vaultId, id);
    return this.prisma.project
      .update({
        where: { id },
        data: {
          ...(dto.name ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
          ...(dto.archived !== undefined ? { archivedAt: dto.archived ? new Date() : null } : {}),
        },
      })
      .catch(uniqueViolation);
  }

  /** Items are kept and simply lose the project. */
  async deleteProject(vaultId: string, id: string) {
    await this.ownedProject(vaultId, id);
    await this.prisma.project.delete({ where: { id } });
  }

  private async ownedProject(vaultId: string, id: string) {
    if (!(await this.prisma.project.findFirst({ where: { id, vaultId } })))
      throw new NotFoundException();
  }

  // ─── Collections ───────────────────────────────────────────────────────────

  async listCollections(vaultId: string) {
    const rows = await this.prisma.collection.findMany({
      where: { vaultId },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: { items: { where: { deletedAt: null } }, notes: { where: { deletedAt: null } } },
        },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      color: c.color,
      itemCount: c._count.items,
      noteCount: c._count.notes,
    }));
  }

  async createCollection(vaultId: string, dto: GroupDto) {
    return this.prisma.collection
      .create({
        data: {
          vaultId,
          name: dto.name.trim(),
          description: dto.description ?? null,
          color: dto.color ?? null,
        },
      })
      .catch(uniqueViolation);
  }

  async updateCollection(vaultId: string, id: string, dto: UpdateGroupDto) {
    if (!(await this.prisma.collection.findFirst({ where: { id, vaultId } })))
      throw new NotFoundException();
    return this.prisma.collection
      .update({
        where: { id },
        data: {
          ...(dto.name ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
        },
      })
      .catch(uniqueViolation);
  }

  async deleteCollection(vaultId: string, id: string) {
    if (!(await this.prisma.collection.findFirst({ where: { id, vaultId } })))
      throw new NotFoundException();
    await this.prisma.collection.delete({ where: { id } });
  }

  // ─── Tags ──────────────────────────────────────────────────────────────────

  async listTags(vaultId: string) {
    const rows = await this.prisma.tag.findMany({
      where: { vaultId },
      orderBy: { name: "asc" },
      include: {
        _count: { select: { items: { where: { item: { deletedAt: null } } }, notes: true } },
      },
    });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      itemCount: t._count.items,
      noteCount: t._count.notes,
    }));
  }

  async renameTag(vaultId: string, id: string, dto: RenameTagDto) {
    if (!(await this.prisma.tag.findFirst({ where: { id, vaultId } })))
      throw new NotFoundException();
    return this.prisma.tag
      .update({ where: { id }, data: { name: dto.name.trim().toLowerCase() } })
      .catch(uniqueViolation);
  }

  async deleteTag(vaultId: string, id: string) {
    if (!(await this.prisma.tag.findFirst({ where: { id, vaultId } })))
      throw new NotFoundException();
    await this.prisma.tag.delete({ where: { id } });
  }

  // ─── Relations ─────────────────────────────────────────────────────────────

  async createRelation(vaultId: string, dto: RelationDto) {
    if (dto.fromItemId === dto.toItemId)
      throw new BadRequestException("An item cannot relate to itself");
    const count = await this.prisma.vaultItem.count({
      where: { vaultId, id: { in: [dto.fromItemId, dto.toItemId] } },
    });
    if (count !== 2) throw new NotFoundException();
    // A 2FA link can resolve a "missing 2FA" finding.
    if (dto.kind === "TWO_FACTOR_FOR") await this.findings.markDirty(vaultId);
    return this.prisma.vaultItemRelation.upsert({
      where: {
        fromItemId_toItemId_kind: {
          fromItemId: dto.fromItemId,
          toItemId: dto.toItemId,
          kind: dto.kind,
        },
      },
      create: { fromItemId: dto.fromItemId, toItemId: dto.toItemId, kind: dto.kind },
      update: {},
    });
  }

  async deleteRelation(vaultId: string, id: string) {
    const rel = await this.prisma.vaultItemRelation.findFirst({ where: { id, from: { vaultId } } });
    if (!rel) throw new NotFoundException();
    await this.prisma.vaultItemRelation.delete({ where: { id } });
    if (rel.kind === "TWO_FACTOR_FOR") await this.findings.markDirty(vaultId);
  }
}

@UseGuards(VaultUnlockedGuard)
@Controller()
export class OrganizeController {
  constructor(private readonly svc: OrganizeService) {}

  @Get("projects") listProjects(@Auth() a: AuthContext) {
    return this.svc.listProjects(a.vaultId);
  }
  @Post("projects") createProject(@Auth() a: AuthContext, @Body() dto: GroupDto) {
    return this.svc.createProject(a.vaultId, dto);
  }
  @Get("projects/:id") getProject(@Auth() a: AuthContext, @Id() id: string) {
    return this.svc.getProject(a.vaultId, id);
  }
  @Patch("projects/:id") updateProject(
    @Auth() a: AuthContext,
    @Id() id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.svc.updateProject(a.vaultId, id, dto);
  }
  @Delete("projects/:id") @HttpCode(204) async deleteProject(
    @Auth() a: AuthContext,
    @Id() id: string,
  ) {
    await this.svc.deleteProject(a.vaultId, id);
  }

  @Get("collections") listCollections(@Auth() a: AuthContext) {
    return this.svc.listCollections(a.vaultId);
  }
  @Post("collections") createCollection(@Auth() a: AuthContext, @Body() dto: GroupDto) {
    return this.svc.createCollection(a.vaultId, dto);
  }
  @Patch("collections/:id") updateCollection(
    @Auth() a: AuthContext,
    @Id() id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.svc.updateCollection(a.vaultId, id, dto);
  }
  @Delete("collections/:id") @HttpCode(204) async deleteCollection(
    @Auth() a: AuthContext,
    @Id() id: string,
  ) {
    await this.svc.deleteCollection(a.vaultId, id);
  }

  @Get("tags") listTags(@Auth() a: AuthContext) {
    return this.svc.listTags(a.vaultId);
  }
  @Patch("tags/:id") renameTag(
    @Auth() a: AuthContext,
    @Id() id: string,
    @Body() dto: RenameTagDto,
  ) {
    return this.svc.renameTag(a.vaultId, id, dto);
  }
  @Delete("tags/:id") @HttpCode(204) async deleteTag(@Auth() a: AuthContext, @Id() id: string) {
    await this.svc.deleteTag(a.vaultId, id);
  }

  @Post("relations") createRelation(@Auth() a: AuthContext, @Body() dto: RelationDto) {
    return this.svc.createRelation(a.vaultId, dto);
  }
  @Delete("relations/:id") @HttpCode(204) async deleteRelation(
    @Auth() a: AuthContext,
    @Id() id: string,
  ) {
    await this.svc.deleteRelation(a.vaultId, id);
  }
}

@Module({
  controllers: [OrganizeController],
  providers: [OrganizeService],
  exports: [OrganizeService],
})
export class OrganizeModule {}
