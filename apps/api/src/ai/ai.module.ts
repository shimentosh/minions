import {
  type AiClassifyResponse,
  type Classification,
  type ClassificationPreference,
  classify,
  confidenceBand,
  getItemType,
  ITEM_TYPES,
  normalizeHost,
  preferenceKeys,
  sanitizeForAi,
} from "@minions/core";
import { Body, Controller, Get, HttpCode, Injectable, Module, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from "class-validator";
import { Auth, type AuthContext } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import { DeepSeekClient, UnsafeAiPayloadError } from "./deepseek.client";

class ClassifyDto {
  @IsOptional() @IsString() @MaxLength(500) text?: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(253) host?: string;
  @IsOptional() @IsString() @MaxLength(100) provider?: string;
  @IsOptional() @IsString() @MaxLength(40) typeHint?: string;
}

class FeedbackDto {
  @IsOptional() @IsUUID(4) classificationId?: string;
  @IsOptional() @IsString() @MaxLength(100) provider?: string;
  @IsOptional() @IsString() @MaxLength(253) host?: string;
  @IsString() @MaxLength(40) type!: string;
  @IsOptional() @IsString() @Length(1, 80) project?: string;
  @IsOptional() @IsString() @Length(1, 80) collection?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  tags?: string[];
  @IsIn(["accepted", "corrected"]) outcome!: "accepted" | "corrected";
}

const SYSTEM_PROMPT = `You organise entries in a personal password and secrets vault.
You receive only non-secret metadata about one entry. Reply with JSON:
{"type": one of ${ITEM_TYPES.map((t) => t.type).join("|")},
 "provider": service name or null,
 "project": one of the given projects or null,
 "collection": a short collection name (prefer one of the given collections) or null,
 "environment": "Development"|"Staging"|"Production"|null,
 "tags": up to 5 lowercase tags,
 "confidence": number 0-1}
Do not invent projects. If unsure, lower the confidence.`;

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deepseek: DeepSeekClient,
  ) {}

  private async context(auth: AuthContext) {
    const [projects, collections, prefs, user] = await Promise.all([
      this.prisma.project.findMany({
        where: { vaultId: auth.vaultId, archivedAt: null },
        select: { name: true },
      }),
      this.prisma.collection.findMany({ where: { vaultId: auth.vaultId }, select: { name: true } }),
      this.prisma.userClassificationPreference.findMany({
        where: { userId: auth.userId },
        orderBy: { weight: "desc" },
        take: 500,
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: { aiEnabled: true },
      }),
    ]);
    return {
      projects: projects.map((p) => p.name),
      collections: collections.map((c) => c.name),
      preferences: prefs.map((p) => ({
        matchKey: p.matchKey,
        target: p.target as ClassificationPreference["target"],
        value: p.value,
        weight: p.weight,
      })),
      aiEnabled: user.aiEnabled,
    };
  }

  /**
   * Rules → learned preferences → AI, in that order. AI only runs when the
   * first two are not confident, the user allows it, a key is configured,
   * and the entry is not financial.
   */
  async classify(auth: AuthContext, dto: ClassifyDto): Promise<AiClassifyResponse> {
    const ctx = await this.context(auth);
    const host = normalizeHost(dto.host ?? null);
    const rules = classify(
      {
        text: dto.text,
        name: dto.name,
        host,
        provider: dto.provider,
        type: dto.typeHint && getItemType(dto.typeHint) ? dto.typeHint : undefined,
      },
      ctx,
    );
    const financial = getItemType(dto.typeHint ?? rules.type)?.financial;
    if (
      confidenceBand(rules.confidence) === "high" ||
      financial ||
      !ctx.aiEnabled ||
      !this.deepseek.available
    ) {
      return {
        available: this.deepseek.available && ctx.aiEnabled && !financial,
        classification: rules,
      };
    }

    const payload = sanitizeForAi({
      name: dto.name ?? "",
      text: dto.text ?? "",
      host: host ?? "",
      provider: dto.provider ?? rules.provider ?? "",
      typeHint: dto.typeHint ?? "",
      projects: ctx.projects.slice(0, 50),
      collections: ctx.collections.slice(0, 50),
    });
    const record = await this.prisma.aiClassification.create({
      data: { userId: auth.userId, input: payload, status: "pending" },
    });
    let raw: Record<string, unknown> | null = null;
    try {
      raw = await this.deepseek.completeJson(SYSTEM_PROMPT, payload);
    } catch (e) {
      if (!(e instanceof UnsafeAiPayloadError)) throw e;
      await this.prisma.aiClassification.update({
        where: { id: record.id },
        data: { status: "blocked" },
      });
      return { available: true, classification: rules };
    }
    const ai = raw ? this.parse(raw, ctx.projects) : null;
    if (!ai) {
      await this.prisma.aiClassification.update({
        where: { id: record.id },
        data: { status: "failed" },
      });
      return { available: true, classification: rules };
    }
    const merged: Classification =
      ai.confidence > rules.confidence
        ? {
            ...ai,
            provider: ai.provider ?? rules.provider,
            project: ai.project ?? rules.project,
            tags: [...new Set([...ai.tags, ...rules.tags])].slice(0, 8),
          }
        : rules;
    await this.prisma.aiClassification.update({
      where: { id: record.id },
      data: {
        output: ai as object,
        model: "deepseek",
        confidence: ai.confidence,
        status: "suggested",
      },
    });
    return { available: true, classification: merged, id: record.id };
  }

  /** Validates the model's answer. Anything outside the contract is dropped. */
  parse(raw: Record<string, unknown>, projects: string[]): Classification | null {
    const type = typeof raw.type === "string" && getItemType(raw.type) ? raw.type : null;
    if (!type) return null;
    const str = (v: unknown, max = 80) =>
      typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined;
    const project = str(raw.project);
    const env = str(raw.environment);
    const confidence =
      typeof raw.confidence === "number" ? Math.min(Math.max(raw.confidence, 0), 1) : 0.5;
    return {
      type,
      provider: str(raw.provider),
      project: project && projects.includes(project) ? project : undefined,
      collection: str(raw.collection, 40),
      environment: env && ["Development", "Staging", "Production"].includes(env) ? env : undefined,
      tags: Array.isArray(raw.tags)
        ? raw.tags
            .filter((t): t is string => typeof t === "string" && /^[a-z0-9 -]{1,30}$/.test(t))
            .slice(0, 5)
        : [],
      // Capped so an AI answer alone never reaches "auto-apply".
      confidence: Math.min(confidence, 0.84),
      reasons: ["Suggested by AI from the item's name and website"],
      source: "ai",
    };
  }

  /** The user accepted or corrected a suggestion: remember it for next time. */
  async feedback(auth: AuthContext, dto: FeedbackDto) {
    const keys = preferenceKeys({
      provider: dto.provider,
      host: normalizeHost(dto.host ?? null),
      type: dto.type,
    });
    const targets: [string, string | undefined][] = [
      ["project", dto.project],
      ["collection", dto.collection],
      ["type", dto.type],
      ...(dto.tags ?? []).map((t): [string, string] => ["tag", t.toLowerCase()]),
    ];
    for (const matchKey of keys) {
      for (const [target, value] of targets) {
        if (!value) continue;
        await this.prisma.userClassificationPreference.upsert({
          where: { userId_matchKey_target_value: { userId: auth.userId, matchKey, target, value } },
          create: {
            userId: auth.userId,
            matchKey,
            target,
            value,
            weight: dto.outcome === "corrected" ? 2 : 1,
          },
          update: { weight: { increment: dto.outcome === "corrected" ? 2 : 1 } },
        });
      }
    }
    if (dto.classificationId) {
      await this.prisma.aiClassification.updateMany({
        where: { id: dto.classificationId, userId: auth.userId },
        data: { status: dto.outcome },
      });
    }
  }
}

@Controller("ai")
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly deepseek: DeepSeekClient,
  ) {}

  @Get("status")
  status() {
    return { available: this.deepseek.available };
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("classify")
  @HttpCode(200)
  classify(@Auth() auth: AuthContext, @Body() dto: ClassifyDto) {
    return this.ai.classify(auth, dto);
  }

  @Post("feedback")
  @HttpCode(204)
  async feedback(@Auth() auth: AuthContext, @Body() dto: FeedbackDto) {
    await this.ai.feedback(auth, dto);
  }
}

@Module({
  controllers: [AiController],
  providers: [AiService, DeepSeekClient],
  exports: [AiService],
})
export class AiModule {}
