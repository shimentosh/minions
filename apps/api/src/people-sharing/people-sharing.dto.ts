import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

// Shapes only; the service checks each one is a key for the right thing.
const SEALED = /^r1\.[A-Za-z0-9+/]{512}$/;
const ENVELOPE = /^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/=]{24,200}$/;

/** 1 hour, 1 day, 7 days, 30 days, 90 days; 0 = never. */
export const PEOPLE_EXPIRY_CHOICES = [60, 1440, 10080, 43200, 129600, 0];

export class LookupQuery {
  @IsEmail() @MaxLength(254) email!: string;
}

export class SharedMatchQuery {
  @IsString() @MaxLength(253) host!: string;
}

export class SharedSearchQuery {
  @IsString() @MaxLength(200) q!: string;
}

export class CreatePeopleShareDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsIn(["VIEW", "EDIT"]) permission!: "VIEW" | "EDIT";
  @IsIn(PEOPLE_EXPIRY_CHOICES) expiresInMinutes!: number;
  @IsOptional() @IsUUID(4) recipientUserId?: string;
  @IsOptional() @Matches(SEALED) sealedItemKey?: string;
}

export class UpdatePeopleShareDto {
  @IsOptional() @IsIn(["VIEW", "EDIT"]) permission?: "VIEW" | "EDIT";
  @IsOptional() @IsIn(PEOPLE_EXPIRY_CHOICES) expiresInMinutes?: number;
}

class FieldValueDto {
  @IsString() @Length(1, 120) key!: string;
  @IsString() @MaxLength(65536) value!: string;
}

class VersionDto {
  @IsUUID() id!: string;
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => FieldValueDto)
  fields!: FieldValueDto[];
}

class SealDto {
  @IsUUID(4) shareId!: string;
  @Matches(SEALED) sealedItemKey!: string;
}

export class SetItemKeyDto {
  @Matches(ENVELOPE) protectedItemKey!: string;
  @IsInt() @Min(1) revision!: number;
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => FieldValueDto)
  fields!: FieldValueDto[];
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => VersionDto)
  versions!: VersionDto[];
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SealDto)
  seals!: SealDto[];
}

export class CompleteSealDto {
  @IsUUID(4) recipientUserId!: string;
  @Matches(SEALED) sealedItemKey!: string;
  /** The wrapped item key the client opened, so a seal made before a re-key is refused. */
  @Matches(ENVELOPE) protectedItemKey!: string;
}
