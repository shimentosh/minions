import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { Action } from "../activity/activity.service";
import { Auth, type AuthContext } from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import {
  ListItemsQuery,
  MatchQuery,
  MergeDto,
  PatchItemDto,
  SuggestionsQuery,
  UpsertItemDto,
  UsageDto,
} from "./items.dto";
import { ItemsService } from "./items.service";

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

@UseGuards(VaultUnlockedGuard)
@Controller("vault/items")
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() q: ListItemsQuery) {
    return this.items.list(auth, q);
  }

  /** Values already used in this vault for a type's non-secret fields (registrar, provider…). */
  @Get("suggestions")
  suggestions(@Auth() auth: AuthContext, @Query() q: SuggestionsQuery) {
    return this.items.suggestions(auth, q.type);
  }

  /** Every item with a 2FA secret, the secret still encrypted: the Authenticator page. */
  @Get("totp")
  totp(@Auth() auth: AuthContext) {
    return this.items.totpItems(auth);
  }

  @Get("match")
  match(@Auth() auth: AuthContext, @Query() q: MatchQuery) {
    return this.items.match(auth, q.host);
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body() dto: UpsertItemDto) {
    return this.items.create(auth, dto);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Id() id: string) {
    return this.items.get(auth, id);
  }

  @Put(":id")
  update(@Auth() auth: AuthContext, @Id() id: string, @Body() dto: UpsertItemDto) {
    return this.items.update(auth, id, dto);
  }

  @Patch(":id")
  patch(@Auth() auth: AuthContext, @Id() id: string, @Body() dto: PatchItemDto) {
    return this.items.patch(auth, id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Auth() auth: AuthContext, @Id() id: string) {
    await this.items.remove(auth, id);
  }

  @Post(":id/restore")
  @HttpCode(204)
  async restore(@Auth() auth: AuthContext, @Id() id: string) {
    await this.items.restore(auth, id);
  }

  @Delete(":id/purge")
  @HttpCode(204)
  async purge(@Auth() auth: AuthContext, @Id() id: string) {
    await this.items.purge(auth, id);
  }

  @Get(":id/versions")
  versions(@Auth() auth: AuthContext, @Id() id: string) {
    return this.items.versions(auth, id);
  }

  @Post(":id/usage")
  @HttpCode(204)
  async usage(@Auth() auth: AuthContext, @Id() id: string, @Body() dto: UsageDto) {
    await this.items.recordUsage(auth, id, dto.action as Action, dto.field);
  }

  @Post(":id/merge")
  @HttpCode(200)
  merge(@Auth() auth: AuthContext, @Id() id: string, @Body() dto: MergeDto) {
    return this.items.merge(auth, id, dto.sourceIds);
  }
}
