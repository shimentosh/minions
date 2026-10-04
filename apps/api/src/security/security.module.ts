import type { FindingType } from "@minions/core";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from "class-validator";
import { Auth, type AuthContext } from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import { SecurityService } from "./security.service";

class FindingStateDto {
  @IsString() @Length(1, 400) key!: string;
  @IsIn(["dismissed", "keep_separate"]) status!: "dismissed" | "keep_separate";
}

class FindingKeyQuery {
  @IsString() @Length(1, 400) key!: string;
}

class FindingsPageQuery {
  @IsIn([
    "reused_password",
    "weak_password",
    "missing_2fa",
    "old_password",
    "expiring",
    "expired",
    "unused",
    "incomplete",
    "duplicate",
  ])
  type!: FindingType;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

class LimitQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

@Controller()
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @UseGuards(VaultUnlockedGuard)
  @Get("security/findings")
  overview(@Auth() auth: AuthContext) {
    return this.security.overview(auth);
  }

  @UseGuards(VaultUnlockedGuard)
  @Get("security/findings/page")
  page(@Auth() auth: AuthContext, @Query() q: FindingsPageQuery) {
    return this.security.listFindings(auth, q.type, q.offset ?? 0, q.limit ?? 50);
  }

  @UseGuards(VaultUnlockedGuard)
  @Post("security/findings/state")
  @HttpCode(204)
  async setState(@Auth() auth: AuthContext, @Body() dto: FindingStateDto) {
    await this.security.setFindingState(auth, dto.key, dto.status);
  }

  @UseGuards(VaultUnlockedGuard)
  @Delete("security/findings/state")
  @HttpCode(204)
  async clearState(@Auth() auth: AuthContext, @Query() q: FindingKeyQuery) {
    await this.security.setFindingState(auth, q.key, null);
  }

  /** Security events stay visible while locked: they hold no vault data. */
  @Get("security/events")
  events(@Auth() auth: AuthContext, @Query() q: LimitQuery) {
    return this.security.events(auth, q.limit);
  }

  @UseGuards(VaultUnlockedGuard)
  @Get("dashboard")
  dashboard(@Auth() auth: AuthContext) {
    return this.security.dashboard(auth);
  }
}

@Module({
  controllers: [SecurityController],
  providers: [SecurityService],
  exports: [SecurityService],
})
export class SecurityModule {}
