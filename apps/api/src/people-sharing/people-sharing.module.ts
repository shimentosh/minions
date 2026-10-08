import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Action } from "../activity/activity.service";
import { Auth, type AuthContext } from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import { UpsertItemDto, UsageDto } from "../vault-items/items.dto";
import { ItemsService } from "../vault-items/items.service";
import {
  CompleteSealDto,
  CreatePeopleShareDto,
  LookupQuery,
  SetItemKeyDto,
  SharedMatchQuery,
  SharedSearchQuery,
  UpdatePeopleShareDto,
} from "./people-sharing.dto";
import { PeopleSharingService } from "./people-sharing.service";

const Uuid = (name: string) => Param(name, new ParseUUIDPipe({ version: "4" }));

/**
 * The owner's side: who a personal item is shared with, and the keys for it.
 * Every route returns or accepts key material or ciphertext, so all of them
 * need an unlocked vault.
 */
@UseGuards(VaultUnlockedGuard)
@Controller()
export class PeopleSharingController {
  constructor(private readonly sharing: PeopleSharingService) {}

  /** Tells whether an address has an account: tighter limit than the global one. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("people-shares/lookup")
  lookup(@Auth() auth: AuthContext, @Query() q: LookupQuery) {
    return this.sharing.lookup(auth, q.email);
  }

  @Get("people-shares")
  sharedByMe(@Auth() auth: AuthContext) {
    return this.sharing.sharedByMe(auth);
  }

  @Get("people-shares/pending-seals")
  pendingSeals(@Auth() auth: AuthContext) {
    return this.sharing.pendingSeals(auth);
  }

  @Post("people-shares/:shareId/seal")
  @HttpCode(204)
  async completeSeal(
    @Auth() auth: AuthContext,
    @Uuid("shareId") shareId: string,
    @Body() dto: CompleteSealDto,
  ) {
    await this.sharing.completeSeal(auth, shareId, dto);
  }

  @Get("vault/items/:id/people")
  forItem(@Auth() auth: AuthContext, @Uuid("id") id: string) {
    return this.sharing.forItem(auth, id);
  }

  /** Sends an email, so it is limited like other mail-sending routes. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("vault/items/:id/people")
  create(@Auth() auth: AuthContext, @Uuid("id") id: string, @Body() dto: CreatePeopleShareDto) {
    return this.sharing.create(auth, id, dto);
  }

  @Patch("vault/items/:id/people/:shareId")
  update(
    @Auth() auth: AuthContext,
    @Uuid("id") id: string,
    @Uuid("shareId") shareId: string,
    @Body() dto: UpdatePeopleShareDto,
  ) {
    return this.sharing.update(auth, id, shareId, dto);
  }

  @Delete("vault/items/:id/people/:shareId")
  remove(@Auth() auth: AuthContext, @Uuid("id") id: string, @Uuid("shareId") shareId: string) {
    return this.sharing.remove(auth, id, shareId);
  }

  @Get("vault/items/:id/item-key")
  keyMaterial(@Auth() auth: AuthContext, @Uuid("id") id: string) {
    return this.sharing.keyMaterial(auth, id);
  }

  @Post("vault/items/:id/item-key")
  @HttpCode(200)
  setItemKey(@Auth() auth: AuthContext, @Uuid("id") id: string, @Body() dto: SetItemKeyDto) {
    return this.sharing.setItemKey(auth, id, dto);
  }
}

/** The recipient's side: items other people shared with the caller. */
@UseGuards(VaultUnlockedGuard)
@Controller("shared")
export class SharedWithMeController {
  constructor(private readonly sharing: PeopleSharingService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.sharing.sharedWithMe(auth);
  }

  /** The extension: shared logins for the current site. */
  @Get("match")
  match(@Auth() auth: AuthContext, @Query() q: SharedMatchQuery) {
    return this.sharing.matchShared(auth, q.host);
  }

  @Get("search")
  search(@Auth() auth: AuthContext, @Query() q: SharedSearchQuery) {
    return this.sharing.searchShared(auth, q.q);
  }

  @Get("items/:itemId")
  get(@Auth() auth: AuthContext, @Uuid("itemId") itemId: string) {
    return this.sharing.getShared(auth, itemId);
  }

  @Put("items/:itemId")
  update(@Auth() auth: AuthContext, @Uuid("itemId") itemId: string, @Body() dto: UpsertItemDto) {
    return this.sharing.updateShared(auth, itemId, dto);
  }

  @Post("items/:itemId/usage")
  @HttpCode(204)
  async usage(@Auth() auth: AuthContext, @Uuid("itemId") itemId: string, @Body() dto: UsageDto) {
    await this.sharing.usage(auth, itemId, dto.action as Action, dto.field);
  }

  @Delete(":shareId")
  @HttpCode(204)
  async leave(@Auth() auth: AuthContext, @Uuid("shareId") shareId: string) {
    await this.sharing.leave(auth, shareId);
  }
}

@Module({
  controllers: [PeopleSharingController, SharedWithMeController],
  providers: [PeopleSharingService, ItemsService],
})
export class PeopleSharingModule {}
