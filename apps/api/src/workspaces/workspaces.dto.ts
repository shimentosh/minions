import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
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
import { UpsertItemDto } from "../vault-items/items.dto";

// Shapes only; the services check that each one is really a key for the right thing.
const SEALED = /^r1\.[A-Za-z0-9+/]{512}$/;
const ENVELOPE = /^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/=]{24,200}$/;

export class KeyPairDto {
  /** Base64 SPKI of an RSA-3072 key; the service parses and checks it. */
  @IsString() @Length(400, 800) @Matches(/^[A-Za-z0-9+/]+={0,2}$/) publicKey!: string;
  @IsString() @Length(100, 4000) @Matches(/^v1\./) protectedPrivateKey!: string;
}

export class CreateWorkspaceDto {
  @IsUUID(4) id!: string;
  @IsString() @Length(1, 80) name!: string;
  /** The new workspace key sealed to the creator's own public key. */
  @Matches(SEALED) protectedWorkspaceKey!: string;
}

export class RenameWorkspaceDto {
  @IsString() @Length(1, 80) name!: string;
}

export class InviteDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsIn(["ADMIN", "MEMBER"]) role!: "ADMIN" | "MEMBER";
}

export class ConfirmMemberDto {
  @Matches(SEALED) protectedWorkspaceKey!: string;
}

export class ChangeRoleDto {
  @IsIn(["ADMIN", "MEMBER"]) role!: "ADMIN" | "MEMBER";
}

export class AccessGrantDto {
  @IsUUID(4) userId!: string;
  @IsIn(["VIEW", "MANAGE"]) permission!: "VIEW" | "MANAGE";
  @IsOptional() @Matches(SEALED) protectedItemKey?: string;
}

export class ItemAccessDto {
  @IsBoolean() workspaceShared!: boolean;
  @IsOptional() @Matches(ENVELOPE) workspaceWrappedKey?: string;
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AccessGrantDto)
  grants!: AccessGrantDto[];
}

export class CreateWorkspaceItemDto {
  @ValidateNested() @Type(() => UpsertItemDto) item!: UpsertItemDto;
  @ValidateNested() @Type(() => ItemAccessDto) access!: ItemAccessDto;
}

export class RekeyItemDto {
  @ValidateNested() @Type(() => UpsertItemDto) item!: UpsertItemDto;
  @ValidateNested() @Type(() => ItemAccessDto) access!: ItemAccessDto;
}

export class WorkspacePatchItemDto {
  @IsOptional() @IsBoolean() favorite?: boolean;
  @IsOptional() @IsUUID(4) collectionId?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  tags?: string[];
  @IsOptional() @IsString() @Length(1, 200) name?: string;
}

/** A workspace key rotation: the new key sealed to every confirmed member, and every shared item re-wrapped. */
export class RekeyWorkspaceDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => SealedForMemberDto)
  members!: SealedForMemberDto[];
  @IsArray()
  @ArrayMaxSize(20000)
  @ValidateNested({ each: true })
  @Type(() => WrappedItemKeyDto)
  items!: WrappedItemKeyDto[];
}

export class SealedForMemberDto {
  @IsUUID(4) userId!: string;
  @Matches(SEALED) protectedWorkspaceKey!: string;
}

export class WrappedItemKeyDto {
  @IsUUID(4) itemId!: string;
  @Matches(ENVELOPE) workspaceWrappedKey!: string;
}

export class FolderDto {
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @Matches(/^#[0-9a-f]{6}$/i) color?: string | null;
}

export class WorkspaceMatchQuery {
  @IsString() @MaxLength(253) @Matches(/^[a-z0-9.-]+$/i) host!: string;
}

export class AuditQuery {
  @IsOptional() @IsUUID(4) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID(4) userId?: string;
}

export class WorkspaceUsageDto {
  @IsIn(["item.copied", "item.autofilled", "item.totp_generated", "item.revealed"]) action!: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9_:-]{1,120}$/) field?: string;
}
