import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from "class-validator";

export class GroupDto {
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @Matches(/^#[0-9a-f]{6}$/i) color?: string | null;
}

export class UpdateGroupDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @Matches(/^#[0-9a-f]{6}$/i) color?: string | null;
  @IsOptional() @IsBoolean() archived?: boolean;
}

export class RenameTagDto {
  @IsString() @Length(1, 40) name!: string;
}

export class RelationDto {
  @IsUUID(4) fromItemId!: string;
  @IsUUID(4) toItemId!: string;
  @IsIn(["USED_FOR", "SERVICE_OF", "RECOVERY_FOR", "TWO_FACTOR_FOR", "RELATED"]) kind!: string;
}
