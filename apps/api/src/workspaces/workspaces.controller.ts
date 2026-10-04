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
import { IsString, MaxLength } from "class-validator";
import type { Action } from "../activity/activity.service";
import { Auth, type AuthContext } from "../common/auth-context";
import { VaultUnlockedGuard } from "../common/guards";
import { ListItemsQuery, UpsertItemDto } from "../vault-items/items.dto";
import { ItemsService } from "../vault-items/items.service";
import { WorkspaceAccess } from "./access";
import { WorkspaceItemsService } from "./workspace-items.service";
import {
  AuditQuery,
  ChangeRoleDto,
  ConfirmMemberDto,
  CreateWorkspaceDto,
  CreateWorkspaceItemDto,
  FolderDto,
  InviteDto,
  ItemAccessDto,
  KeyPairDto,
  RekeyItemDto,
  RekeyWorkspaceDto,
  RenameWorkspaceDto,
  WorkspaceMatchQuery,
  WorkspacePatchItemDto,
  WorkspaceUsageDto,
} from "./workspaces.dto";
import { WorkspacesService } from "./workspaces.service";

const Uuid = (name: string) => Param(name, new ParseUUIDPipe({ version: "4" }));

class SearchQuery {
  @IsString() @MaxLength(200) q!: string;
}

/** The caller's sharing key pair. Set once, from an unlocked client. */
@UseGuards(VaultUnlockedGuard)
@Controller("account/keypair")
export class KeyPairController {
  constructor(private readonly ws: WorkspacesService) {}

  @Post()
  @HttpCode(204)
  async set(@Auth() auth: AuthContext, @Body() dto: KeyPairDto) {
    await this.ws.setKeyPair(auth, dto);
  }
}

/**
 * Workspaces, members and shared credentials. Every route returns or accepts
 * ciphertext or access data, so all of them need an unlocked vault, and every
 * one checks membership and permission on the server (WorkspaceAccess).
 */
@UseGuards(VaultUnlockedGuard)
@Controller("workspaces")
export class WorkspacesController {
  constructor(
    private readonly ws: WorkspacesService,
    private readonly items: WorkspaceItemsService,
  ) {}

  // Static paths first, so they are not read as a workspace id.

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.ws.list(auth);
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body() dto: CreateWorkspaceDto) {
    return this.ws.create(auth, dto);
  }

  @Get("invitations")
  invitations(@Auth() auth: AuthContext) {
    return this.ws.myInvitations(auth);
  }

  @Post("invitations/:memberId/accept")
  @HttpCode(200)
  accept(@Auth() auth: AuthContext, @Uuid("memberId") memberId: string) {
    return this.ws.accept(auth, memberId);
  }

  @Post("invitations/:memberId/decline")
  @HttpCode(204)
  async decline(@Auth() auth: AuthContext, @Uuid("memberId") memberId: string) {
    await this.ws.decline(auth, memberId);
  }

  /** Extension: workspace logins for one host, across the caller's workspaces. */
  @Get("items/match")
  match(@Auth() auth: AuthContext, @Query() q: WorkspaceMatchQuery) {
    return this.items.match(auth, q.host);
  }

  @Get("items/search")
  search(@Auth() auth: AuthContext, @Query() q: SearchQuery) {
    return this.items.search(auth, q.q);
  }

  // ─── One workspace ─────────────────────────────────────────────────────────

  @Get(":workspaceId")
  get(@Auth() auth: AuthContext, @Uuid("workspaceId") id: string) {
    return this.ws.get(auth, id);
  }

  @Patch(":workspaceId")
  @HttpCode(204)
  async rename(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Body() dto: RenameWorkspaceDto,
  ) {
    await this.ws.rename(auth, id, dto.name);
  }

  @Delete(":workspaceId")
  @HttpCode(204)
  async remove(@Auth() auth: AuthContext, @Uuid("workspaceId") id: string) {
    await this.ws.remove(auth, id);
  }

  @Post(":workspaceId/leave")
  @HttpCode(200)
  leave(@Auth() auth: AuthContext, @Uuid("workspaceId") id: string) {
    return this.ws.leave(auth, id);
  }

  @Post(":workspaceId/rekey")
  @HttpCode(204)
  async rekeyWorkspace(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Body() dto: RekeyWorkspaceDto,
  ) {
    await this.ws.rekey(auth, id, dto);
  }

  @Get(":workspaceId/activity")
  audit(@Auth() auth: AuthContext, @Uuid("workspaceId") id: string, @Query() q: AuditQuery) {
    return this.ws.audit(auth, id, q);
  }

  // ─── Members ───────────────────────────────────────────────────────────────

  @Get(":workspaceId/members")
  members(@Auth() auth: AuthContext, @Uuid("workspaceId") id: string) {
    return this.ws.members(auth, id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(":workspaceId/members")
  invite(@Auth() auth: AuthContext, @Uuid("workspaceId") id: string, @Body() dto: InviteDto) {
    return this.ws.invite(auth, id, dto);
  }

  @Get(":workspaceId/members/:memberId")
  profile(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("memberId") memberId: string,
  ) {
    return this.ws.profile(auth, id, memberId);
  }

  @Post(":workspaceId/members/:memberId/confirm")
  @HttpCode(204)
  async confirm(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("memberId") memberId: string,
    @Body() dto: ConfirmMemberDto,
  ) {
    await this.ws.confirm(auth, id, memberId, dto);
  }

  @Patch(":workspaceId/members/:memberId")
  @HttpCode(204)
  async changeRole(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("memberId") memberId: string,
    @Body() dto: ChangeRoleDto,
  ) {
    await this.ws.changeRole(auth, id, memberId, dto);
  }

  @Delete(":workspaceId/members/:memberId")
  @HttpCode(200)
  removeMember(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("memberId") memberId: string,
  ) {
    return this.ws.removeMember(auth, id, memberId);
  }

  // ─── Folders and tags ──────────────────────────────────────────────────────

  @Get(":workspaceId/folders")
  folders(@Auth() auth: AuthContext, @Uuid("workspaceId") id: string) {
    return this.ws.folders(auth, id);
  }

  @Post(":workspaceId/folders")
  createFolder(@Auth() auth: AuthContext, @Uuid("workspaceId") id: string, @Body() dto: FolderDto) {
    return this.ws.createFolder(auth, id, dto);
  }

  @Delete(":workspaceId/folders/:folderId")
  @HttpCode(204)
  async deleteFolder(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("folderId") folderId: string,
  ) {
    await this.ws.deleteFolder(auth, id, folderId);
  }

  @Get(":workspaceId/tags")
  tags(@Auth() auth: AuthContext, @Uuid("workspaceId") id: string) {
    return this.ws.tags(auth, id);
  }

  // ─── Credentials ───────────────────────────────────────────────────────────

  @Get(":workspaceId/items")
  listItems(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Query() q: ListItemsQuery,
  ) {
    return this.items.list(auth, id, q);
  }

  @Post(":workspaceId/items")
  createItem(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Body() dto: CreateWorkspaceItemDto,
  ) {
    return this.items.create(auth, id, dto);
  }

  @Get(":workspaceId/items/:itemId")
  getItem(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
  ) {
    return this.items.get(auth, id, itemId);
  }

  @Put(":workspaceId/items/:itemId")
  updateItem(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
    @Body() dto: UpsertItemDto,
  ) {
    return this.items.update(auth, id, itemId, dto);
  }

  @Patch(":workspaceId/items/:itemId")
  patchItem(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
    @Body() dto: WorkspacePatchItemDto,
  ) {
    return this.items.patch(auth, id, itemId, dto);
  }

  @Delete(":workspaceId/items/:itemId")
  @HttpCode(204)
  async deleteItem(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
  ) {
    await this.items.remove(auth, id, itemId);
  }

  @Post(":workspaceId/items/:itemId/restore")
  @HttpCode(204)
  async restoreItem(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
  ) {
    await this.items.restore(auth, id, itemId);
  }

  @Delete(":workspaceId/items/:itemId/purge")
  @HttpCode(204)
  async purgeItem(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
  ) {
    await this.items.purge(auth, id, itemId);
  }

  @Get(":workspaceId/items/:itemId/versions")
  versions(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
  ) {
    return this.items.versions(auth, id, itemId);
  }

  @Post(":workspaceId/items/:itemId/usage")
  @HttpCode(204)
  async usage(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
    @Body() dto: WorkspaceUsageDto,
  ) {
    await this.items.usage(auth, id, itemId, dto.action as Action, dto.field);
  }

  @Get(":workspaceId/items/:itemId/access")
  getAccess(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
  ) {
    return this.items.getAccess(auth, id, itemId);
  }

  @Put(":workspaceId/items/:itemId/access")
  setAccess(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
    @Body() dto: ItemAccessDto,
  ) {
    return this.items.setAccess(auth, id, itemId, dto);
  }

  @Post(":workspaceId/items/:itemId/rekey")
  @HttpCode(200)
  rekeyItem(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
    @Body() dto: RekeyItemDto,
  ) {
    return this.items.rekey(auth, id, itemId, dto);
  }

  @Get(":workspaceId/items/:itemId/activity")
  itemActivity(
    @Auth() auth: AuthContext,
    @Uuid("workspaceId") id: string,
    @Uuid("itemId") itemId: string,
  ) {
    return this.items.itemActivity(auth, id, itemId);
  }
}

@Module({
  controllers: [KeyPairController, WorkspacesController],
  providers: [WorkspaceAccess, WorkspacesService, WorkspaceItemsService, ItemsService],
})
export class WorkspacesModule {}
