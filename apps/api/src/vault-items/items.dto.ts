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
  ValidateNested,
} from "class-validator";

export class ItemFieldDto {
  @IsString() @Length(1, 120) key!: string;
  // Envelopes for large secrets (private keys, .env values) can be long.
  @IsString() @MaxLength(65536) value!: string;
  @IsBoolean() sensitive!: boolean;
  @IsOptional() @IsString() @Length(1, 80) label?: string;
  @IsOptional() @IsString() @MaxLength(20) kind?: string;
}

export class SecretSignalsDto {
  @IsOptional() @IsInt() @Min(0) @Max(4) passwordStrength?: number;
  @IsOptional() @Matches(/^[0-9a-f]{64}$/) passwordFingerprint?: string;
  @IsOptional() @Matches(/^\d{4}$/) cardLast4?: string;
  @IsOptional() @IsString() @MaxLength(20) cardBrand?: string;
}

export class UpsertItemDto {
  @IsUUID(4) id!: string;
  @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,40}$/) type!: string;
  @IsString() @Length(1, 200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsUUID(4) projectId?: string | null;
  @IsOptional() @IsUUID(4) collectionId?: string | null;
  @IsOptional() @IsBoolean() favorite?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  tags?: string[];
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ItemFieldDto)
  fields!: ItemFieldDto[];
  @IsOptional() @ValidateNested() @Type(() => SecretSignalsDto) signals?: SecretSignalsDto;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID(4, { each: true }) usedByProjectIds?: string[];
  @IsOptional() @IsInt() @Min(1) revision?: number;
}

export class PatchItemDto {
  @IsOptional() @IsBoolean() favorite?: boolean;
  @IsOptional() @IsUUID(4) projectId?: string | null;
  @IsOptional() @IsUUID(4) collectionId?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  tags?: string[];
  @IsOptional() @IsString() @Length(1, 200) name?: string;
}

export class ListItemsQuery {
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsString() @MaxLength(400) types?: string;
  @IsOptional()
  @IsIn(["login", "secret", "infrastructure", "financial", "other"])
  category?: string;
  @IsOptional() @IsUUID(4) projectId?: string;
  @IsOptional() @IsUUID(4) collectionId?: string;
  @IsOptional() @IsString() @MaxLength(40) tag?: string;
  @IsOptional() @IsIn(["true", "false"]) favorite?: string;
  @IsOptional() @IsIn(["true", "false"]) trash?: string;
  @IsOptional() @IsIn(["updated", "name", "recent", "frequent", "created"]) sort?: string;
  @IsOptional() @IsUUID(4) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class MatchQuery {
  @IsString() @MaxLength(253) @Matches(/^[a-z0-9.-]+$/i) host!: string;
}

export class UsageDto {
  @IsIn(["item.copied", "item.autofilled", "item.totp_generated", "item.revealed"]) action!: string;
  // A field key, never a value: the format leaves no room for one.
  @IsOptional() @IsString() @Matches(/^[a-z0-9_:-]{1,120}$/) field?: string;
}

export class BulkUpsertDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => UpsertItemDto)
  items!: UpsertItemDto[];
  @IsOptional() @IsUUID(4) importJobId?: string;
}

export class MergeDto {
  /** Items folded into the target. Their fields are not copied; the client merges explicitly. */
  @IsArray() @ArrayMaxSize(20) @IsUUID(4, { each: true }) sourceIds!: string[];
}

export class SuggestionsQuery {
  @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,40}$/) type!: string;
}
