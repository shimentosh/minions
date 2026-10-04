import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, Min, ValidateNested } from "class-validator";
import { ActivityService } from "../activity/activity.service";
import { Auth, type AuthContext } from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import { PrismaService } from "../common/prisma.service";
import { UpsertItemDto } from "../vault-items/items.dto";
import { ItemsService } from "../vault-items/items.service";

class CreateJobDto {
  @IsIn([
    "chrome",
    "firefox",
    "bitwarden-csv",
    "bitwarden-json",
    "notion",
    "csv",
    "json",
    "minions-backup",
  ])
  source!: string;
  @IsInt() @Min(0) totalRecords!: number;
  @IsInt() @Min(0) duplicateCount!: number;
  @IsInt() @Min(0) invalidCount!: number;
}

class ImportEntryDto {
  @IsInt() @Min(0) sourceRow!: number;
  @ValidateNested() @Type(() => UpsertItemDto) item!: UpsertItemDto;
}

class ImportBatchDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ImportEntryDto)
  entries!: ImportEntryDto[];
}

class CompleteDto {
  @IsInt() @Min(0) skippedCount!: number;
}

/**
 * Import parsing, normalising, duplicate detection and encryption all happen
 * on the client. The server receives ordinary encrypted items in batches and
 * keeps counts and outcomes, never source content.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly activity: ActivityService,
  ) {}

  createJob(auth: AuthContext, dto: CreateJobDto) {
    return this.prisma.importJob.create({
      data: {
        userId: auth.userId,
        source: dto.source,
        status: "running",
        totalRecords: dto.totalRecords,
        duplicateCount: dto.duplicateCount,
        invalidCount: dto.invalidCount,
      },
    });
  }

  private async job(auth: AuthContext, id: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id, userId: auth.userId } });
    if (!job) throw new NotFoundException();
    return job;
  }

  async addBatch(auth: AuthContext, jobId: string, dto: ImportBatchDto) {
    const job = await this.job(auth, jobId);
    if (job.status !== "running") throw new NotFoundException();
    const results: {
      sourceRow: number;
      itemId: string | null;
      status: "imported" | "failed";
      reason?: string;
    }[] = [];
    for (const entry of dto.entries) {
      try {
        await this.items.create(auth, entry.item, { log: false });
        results.push({ sourceRow: entry.sourceRow, itemId: entry.item.id, status: "imported" });
      } catch (e) {
        // Reasons are our own error messages, never record content.
        const reason =
          e instanceof HttpException
            ? String((e.getResponse() as { message?: string }).message ?? e.message).slice(0, 120)
            : "Failed";
        results.push({ sourceRow: entry.sourceRow, itemId: null, status: "failed", reason });
      }
    }
    await this.prisma.importItem.createMany({ data: results.map((r) => ({ jobId, ...r })) });
    const imported = results.filter((r) => r.status === "imported").length;
    await this.prisma.importJob.update({
      where: { id: jobId },
      data: { importedCount: { increment: imported } },
    });
    return { imported, failed: results.filter((r) => r.status === "failed") };
  }

  async complete(auth: AuthContext, jobId: string, dto: CompleteDto) {
    await this.job(auth, jobId);
    const job = await this.prisma.importJob.update({
      where: { id: jobId },
      data: { status: "completed", skippedCount: dto.skippedCount, completedAt: new Date() },
    });
    await this.activity.log(auth, "import.completed", {
      metadata: {
        jobId,
        source: job.source,
        imported: job.importedCount,
        skipped: dto.skippedCount,
      },
    });
    return job;
  }

  list(auth: AuthContext) {
    return this.prisma.importJob.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  }
}

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

@UseGuards(VaultUnlockedGuard)
@Controller("imports")
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get() list(@Auth() a: AuthContext) {
    return this.imports.list(a);
  }
  @Post() create(@Auth() a: AuthContext, @Body() dto: CreateJobDto) {
    return this.imports.createJob(a, dto);
  }
  @Post(":id/items") @HttpCode(200) batch(
    @Auth() a: AuthContext,
    @Id() id: string,
    @Body() dto: ImportBatchDto,
  ) {
    return this.imports.addBatch(a, id, dto);
  }
  @Post(":id/complete") @HttpCode(200) complete(
    @Auth() a: AuthContext,
    @Id() id: string,
    @Body() dto: CompleteDto,
  ) {
    return this.imports.complete(a, id, dto);
  }
}

@Module({ controllers: [ImportsController], providers: [ImportsService, ItemsService] })
export class ImportsModule {}
