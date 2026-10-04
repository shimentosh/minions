import { Type } from "class-transformer";
import {
  IsBase64,
  IsEmail,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

const ENVELOPE = /^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]+={0,2}$/;

export class DeviceDto {
  @IsString() @Length(8, 100) clientDeviceId!: string;
  @IsString() @Length(1, 100) name!: string;
  @IsIn(["web", "extension", "desktop"]) kind!: "web" | "extension" | "desktop";
}

export class KdfDto {
  @IsIn(["argon2id"]) type!: "argon2id";
  // Floors match MIN_KDF in @minions/core; ceilings stop a client DoS-ing its own logins.
  @IsInt() @Min(19456) @Max(1048576) memory!: number;
  @IsInt() @Min(2) @Max(20) iterations!: number;
  @IsInt() @Min(1) @Max(8) parallelism!: number;
  @IsBase64() @Length(24, 24) salt!: string;
}

export class PreloginDto {
  @IsEmail() @MaxLength(254) email!: string;
}

export class RegisterDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @Length(1, 100) name!: string;
  @IsUUID(4) userId!: string;
  @IsUUID(4) vaultId!: string;
  @IsBase64() @Length(44, 44) authKey!: string;
  @ValidateNested() @Type(() => KdfDto) kdf!: KdfDto;
  @Matches(ENVELOPE) @MaxLength(200) protectedUserKey!: string;
  @Matches(ENVELOPE) @MaxLength(200) protectedVaultKey!: string;
  @ValidateNested() @Type(() => DeviceDto) device!: DeviceDto;
}

export class LoginDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsBase64() @Length(44, 44) authKey!: string;
  @ValidateNested() @Type(() => DeviceDto) device!: DeviceDto;
}

export class TwoFactorVerifyDto {
  /** A 6-digit TOTP code or a recovery code (xxxxx-xxxxx). */
  @IsString() @MinLength(6) @MaxLength(20) code!: string;
}

export class AuthKeyDto {
  @IsBase64() @Length(44, 44) authKey!: string;
}

export class EnableTwoFactorDto extends AuthKeyDto {
  @IsString() @Matches(/^\d{6}$/) code!: string;
}

export class DisableTwoFactorDto extends AuthKeyDto {
  @IsString() @MinLength(6) @MaxLength(20) code!: string;
}

export class ChangePasswordDto {
  @IsBase64() @Length(44, 44) currentAuthKey!: string;
  @IsBase64() @Length(44, 44) newAuthKey!: string;
  @ValidateNested() @Type(() => KdfDto) kdf!: KdfDto;
  @Matches(ENVELOPE) @MaxLength(200) protectedUserKey!: string;
}
