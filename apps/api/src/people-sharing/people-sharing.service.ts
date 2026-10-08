import {
  isEnvelope,
  isSealedKey,
  matchHost,
  normalizeHost,
  type PendingSeal,
  type PeopleShare,
  type PeopleShareStatus,
  registrableDomain,
  type SharedItemDetail,
  type SharedWithMeItem,
  type ShareRecipientLookup,
  type VaultItemSummary,
} from "@minions/core";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { type Action, ActivityService } from "../activity/activity.service";
import type { AuthContext } from "../common/auth-context";
import { PrismaService } from "../common/prisma.service";
import { loadConfig } from "../config";
import type { Prisma } from "../generated/prisma/client";
import { Mailer } from "../mail/mailer";
import { assertSameSecrets } from "../vault/rotation";
import type { UpsertItemDto } from "../vault-items/items.dto";
import { ItemsService, toSummary } from "../vault-items/items.service";
import type {
  CompleteSealDto,
  CreatePeopleShareDto,
  SetItemKeyDto,
  UpdatePeopleShareDto,
} from "./people-sharing.dto";

/** New shares one person may create per day: sharing sends email, so it is capped. */
const DAILY_SHARE_LIMIT = 100;
/** One email per recipient per owner in this window, however many items are shared. */
const MAIL_QUIET_MS = 60 * 60_000;

const SUMMARY_INCLUDE = {
  project: { select: { id: true, name: true, color: true } },
  collection: { select: { id: true, name: true, color: true } },
  tags: { select: { tag: { select: { name: true } } } },
} satisfies Prisma.VaultItemInclude;

const PERSON = { select: { id: true, name: true, email: true } } as const;

type VersionField = { key: string; value: string; sensitive: boolean };

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const notExpired = (): Prisma.ItemShareWhereInput => ({
  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
});

function expiryFrom(minutes: number) {
  return minutes ? new Date(Date.now() + minutes * 60_000) : null;
}

/** A display name that cannot break an email header or body layout. */
function mailName(name: string) {
  return (
    name
      .replace(/[\p{Cc}\p{Cf}<>"]/gu, "")
      .trim()
      .slice(0, 60) || "Someone"
  );
}

function emailNotVerified(message: string) {
  return new ForbiddenException({ message, code: "EMAIL_NOT_VERIFIED" });
}

/**
 * Sharing a personal item with people, by email. See ARCHITECTURE.md §8.
 *
 * The server never holds a key that opens a shared item. The owner's client
 * gives the item its own key (wrapped by the vault key) and seals it to each
 * recipient's public key. A recipient who cannot receive it yet (no account,
 * an unverified email, no sharing keys) waits; the owner's client completes
 * the seal the next time it is open (pending-seals).
 *
 * Identity is the verified email: nothing reaches an account by email until
 * that account has proved it receives mail there.
 */
@Injectable()
export class PeopleSharingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly activity: ActivityService,
    private readonly mailer: Mailer,
  ) {}

  // ─── Owner ─────────────────────────────────────────────────────────────────

  private async me(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, email: true, emailVerifiedAt: true },
    });
  }

  private async requireVerifiedSender(auth: AuthContext) {
    const me = await this.me(auth.userId);
    if (!me.emailVerifiedAt)
      throw emailNotVerified("Confirm your email address before sharing with people");
    return me;
  }

  private async ownedItem(auth: AuthContext, itemId: string) {
    const item = await this.prisma.vaultItem.findFirst({
      where: { id: itemId, vaultId: auth.vaultId },
    });
    if (!item) throw new NotFoundException("Item not found");
    return item;
  }

  /** Accounts at these emails that can receive a share now: verified, with sharing keys. */
  private async readyRecipients(emails: string[]) {
    if (!emails.length)
      return new Map<string, { id: string; name: string; email: string; publicKey: string }>();
    const users = await this.prisma.user.findMany({
      where: {
        email: { in: [...new Set(emails)] },
        emailVerifiedAt: { not: null },
        publicKey: { not: null },
      },
      select: { id: true, name: true, email: true, publicKey: true },
    });
    return new Map(users.map((u) => [u.email, { ...u, publicKey: u.publicKey! }]));
  }

  private toPeopleShare(
    s: Prisma.ItemShareGetPayload<{
      include: { item: { select: { name: true; type: true } }; recipient: typeof PERSON };
    }>,
    ready: Set<string>,
  ): PeopleShare {
    let status: PeopleShareStatus;
    if (s.expiresAt && s.expiresAt <= new Date()) status = "expired";
    else if (s.sealedItemKey) status = "active";
    else status = ready.has(s.email) ? "ready" : "invited";
    return {
      id: s.id,
      itemId: s.itemId,
      itemName: s.item.name,
      itemType: s.item.type,
      email: s.email,
      recipient: s.recipient,
      permission: s.permission,
      status,
      expiresAt: s.expiresAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    };
  }

  private async listShares(where: Prisma.ItemShareWhereInput): Promise<PeopleShare[]> {
    const rows = await this.prisma.itemShare.findMany({
      where,
      include: { item: { select: { name: true, type: true } }, recipient: PERSON },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    const ready = await this.readyRecipients(
      rows.filter((r) => !r.sealedItemKey).map((r) => r.email),
    );
    return rows.map((r) => this.toPeopleShare(r, new Set(ready.keys())));
  }

  /**
   * Whether an email can receive a share right now. This tells a verified,
   * signed-in, unlocked user whether an address has a Minions account (the
   * price of sealing immediately); it is rate limited, and an account that
   * has not verified its email is reported as not found.
   */
  async lookup(auth: AuthContext, email: string): Promise<ShareRecipientLookup> {
    const me = await this.requireVerifiedSender(auth);
    const clean = normalizeEmail(email);
    if (clean === me.email) throw new BadRequestException("That's your own email address");
    const found = (await this.readyRecipients([clean])).get(clean);
    return { email: clean, recipient: found ?? null };
  }

  async forItem(auth: AuthContext, itemId: string) {
    await this.ownedItem(auth, itemId);
    return this.listShares({ itemId, ownerId: auth.userId });
  }

  async sharedByMe(auth: AuthContext) {
    return this.listShares({ ownerId: auth.userId, item: { deletedAt: null } });
  }

  async create(auth: AuthContext, itemId: string, dto: CreatePeopleShareDto) {
    const me = await this.requireVerifiedSender(auth);
    const item = await this.ownedItem(auth, itemId);
    if (item.deletedAt) throw new BadRequestException("Restore the item before sharing it");
    if (!item.protectedItemKey)
      throw new ConflictException({
        message: "This item needs its own key before it can be shared",
        code: "ITEM_KEY_REQUIRED",
      });
    const email = normalizeEmail(dto.email);
    if (email === me.email) throw new BadRequestException("That's your own email address");
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const today = await this.prisma.itemShare.count({
      where: { ownerId: auth.userId, createdAt: { gt: since } },
    });
    if (today >= DAILY_SHARE_LIMIT)
      throw new ForbiddenException({
        message: "You've shared a lot today. Try again tomorrow.",
        code: "SHARE_LIMIT",
      });
    if (await this.prisma.itemShare.findUnique({ where: { itemId_email: { itemId, email } } }))
      throw new ConflictException({
        message: "Already shared with this person",
        code: "ALREADY_SHARED",
      });

    let recipientId: string | null = null;
    let sealedItemKey: string | null = null;
    if (dto.recipientUserId || dto.sealedItemKey) {
      if (!dto.recipientUserId || !isSealedKey(dto.sealedItemKey))
        throw new BadRequestException("A recipient needs the item key sealed to them");
      const ready = (await this.readyRecipients([email])).get(email);
      if (!ready || ready.id !== dto.recipientUserId)
        throw new BadRequestException({
          message: "That person can't receive it yet. Share again to invite them.",
          code: "RECIPIENT_CHANGED",
        });
      recipientId = ready.id;
      sealedItemKey = dto.sealedItemKey!;
    }

    const share = await this.prisma.itemShare.create({
      data: {
        itemId,
        ownerId: auth.userId,
        email,
        recipientId,
        sealedItemKey,
        sealedAt: sealedItemKey ? new Date() : null,
        permission: dto.permission,
        expiresAt: expiryFrom(dto.expiresInMinutes),
      },
    });
    await this.activity.log(auth, "item.shared", {
      item,
      metadata: { member: email, permission: dto.permission, via: "email" },
    });
    await this.notify(me, share.id, email);
    const [out] = await this.listShares({ id: share.id });
    return out!;
  }

  /** Tells the recipient: a notification if they have an account, an invitation if not. */
  private async notify(
    owner: { id: string; name: string; email: string },
    shareId: string,
    email: string,
  ) {
    const recent = await this.prisma.itemShare.findFirst({
      where: {
        ownerId: owner.id,
        email,
        notifiedAt: { gt: new Date(Date.now() - MAIL_QUIET_MS) },
      },
      select: { id: true },
    });
    if (recent) return;
    const base = loadConfig().mail.publicWebUrl;
    const hasAccount = !!(await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    }));
    const from = `${mailName(owner.name)} (${owner.email})`;
    const sent = await this.mailer.send(
      hasAccount
        ? {
            to: email,
            subject: `${mailName(owner.name)} shared a password with you on Minions`,
            text: [
              `${from} shared a password with you on Minions.`,
              "",
              "Open it here:",
              `${base}/shared`,
              "",
              "It is end-to-end encrypted: only you can open it, after you unlock your vault.",
              "If you did not expect this, you can remove it from Shared with me.",
              "Minions will never ask for your master password by email.",
            ].join("\n"),
          }
        : {
            to: email,
            subject: `${mailName(owner.name)} invited you to Minions`,
            text: [
              `${from} wants to share a password with you using Minions, an end-to-end encrypted password manager.`,
              "",
              "Create a free account with this email address to receive it:",
              `${base}/register?email=${encodeURIComponent(email)}`,
              "",
              `Once you have signed up and confirmed your email, ${mailName(owner.name)}'s Minions hands it over automatically the next time they open it.`,
              "If you were not expecting this, ignore this email.",
              "Minions will never ask for your master password by email.",
            ].join("\n"),
          },
    );
    if (sent)
      await this.prisma.itemShare.update({
        where: { id: shareId },
        data: { notifiedAt: new Date() },
      });
  }

  private async ownedShare(auth: AuthContext, itemId: string, shareId: string) {
    const share = await this.prisma.itemShare.findFirst({
      where: { id: shareId, itemId, ownerId: auth.userId, item: { vaultId: auth.vaultId } },
      include: { item: true },
    });
    if (!share) throw new NotFoundException("Share not found");
    return share;
  }

  async update(auth: AuthContext, itemId: string, shareId: string, dto: UpdatePeopleShareDto) {
    const share = await this.ownedShare(auth, itemId, shareId);
    await this.prisma.itemShare.update({
      where: { id: share.id },
      data: {
        ...(dto.permission ? { permission: dto.permission } : {}),
        ...(dto.expiresInMinutes !== undefined
          ? { expiresAt: expiryFrom(dto.expiresInMinutes) }
          : {}),
      },
    });
    if (dto.permission && dto.permission !== share.permission)
      await this.activity.log(auth, "item.access_changed", {
        item: share.item,
        metadata: { member: share.email, permission: dto.permission },
      });
    const [out] = await this.listShares({ id: share.id });
    return out!;
  }

  /**
   * Stops sharing. Someone who held the key may have kept it, so the item is
   * flagged for a new key (the owner's client does that right away).
   */
  async remove(auth: AuthContext, itemId: string, shareId: string) {
    const share = await this.ownedShare(auth, itemId, shareId);
    await this.prisma.$transaction([
      this.prisma.itemShare.delete({ where: { id: share.id } }),
      ...(share.sealedItemKey
        ? [this.prisma.vaultItem.update({ where: { id: itemId }, data: { rekeyNeeded: true } })]
        : []),
    ]);
    await this.activity.log(auth, "item.access_removed", {
      item: share.item,
      metadata: { member: share.email },
    });
    return { rekeyNeeded: !!share.sealedItemKey };
  }

  /**
   * Everything a re-key re-encrypts: the item's secret fields and every
   * version's, still encrypted, plus who holds the current key.
   */
  async keyMaterial(auth: AuthContext, itemId: string) {
    const item = await this.prisma.vaultItem.findFirst({
      where: { id: itemId, vaultId: auth.vaultId },
      select: {
        id: true,
        revision: true,
        protectedItemKey: true,
        fields: { where: { sensitive: true }, select: { key: true, value: true } },
        versions: { select: { id: true, fields: true } },
        peopleShares: {
          where: { sealedItemKey: { not: null } },
          select: { id: true, email: true, recipient: { select: { id: true, publicKey: true } } },
        },
      },
    });
    if (!item) throw new NotFoundException("Item not found");
    return {
      revision: item.revision,
      protectedItemKey: item.protectedItemKey,
      fields: item.fields,
      versions: item.versions.map((v) => ({
        id: v.id,
        fields: (v.fields as unknown as VersionField[])
          .filter((f) => f.sensitive)
          .map(({ key, value }) => ({ key, value })),
      })),
      holders: item.peopleShares.flatMap((s) =>
        s.recipient?.publicKey
          ? [
              {
                shareId: s.id,
                email: s.email,
                userId: s.recipient.id,
                publicKey: s.recipient.publicKey,
              },
            ]
          : [],
      ),
    };
  }

  /**
   * Puts a personal item under its own key, or a fresh one. Like vault-key
   * rotation, the client sends every secret field and version re-encrypted,
   * and the server checks nothing was dropped or left in plaintext. When the
   * item already had a key, every share that held it gets the new one sealed.
   */
  async setItemKey(auth: AuthContext, itemId: string, dto: SetItemKeyDto) {
    const item = await this.prisma.vaultItem.findFirst({
      where: { id: itemId, vaultId: auth.vaultId },
      select: {
        id: true,
        name: true,
        type: true,
        revision: true,
        protectedItemKey: true,
        fields: { where: { sensitive: true }, select: { key: true } },
        versions: { select: { id: true, fields: true } },
        peopleShares: { where: { sealedItemKey: { not: null } }, select: { id: true } },
      },
    });
    if (!item) throw new NotFoundException("Item not found");
    if (item.revision !== dto.revision)
      throw new ConflictException({
        message: "This item changed on another device. Reload and try again.",
        code: "REVISION_CONFLICT",
      });
    if (!isEnvelope(dto.protectedItemKey)) throw new BadRequestException("Invalid wrapped key");
    assertSameSecrets(
      item.fields.map((f) => f.key),
      dto.fields,
    );
    const sentVersions = new Map(dto.versions.map((v) => [v.id, v.fields]));
    if (sentVersions.size !== item.versions.length)
      throw new BadRequestException("Every version must be re-encrypted");
    const versionUpdates = item.versions.map((v) => {
      const fields = v.fields as unknown as VersionField[];
      const sent = sentVersions.get(v.id);
      if (!sent) throw new BadRequestException("Every version must be re-encrypted");
      assertSameSecrets(
        fields.filter((f) => f.sensitive).map((f) => f.key),
        sent,
      );
      const byKey = new Map(sent.map((f) => [f.key, f.value]));
      return {
        id: v.id,
        fields: fields.map((f) =>
          f.sensitive ? { ...f, value: byKey.get(f.key)! } : f,
        ) as unknown as Prisma.InputJsonValue,
      };
    });
    const holders = new Set(item.peopleShares.map((s) => s.id));
    const seals = new Map(dto.seals.map((s) => [s.shareId, s.sealedItemKey]));
    if (seals.size !== holders.size || [...holders].some((id) => !seals.has(id)))
      throw new BadRequestException({
        message: "Everyone who keeps access needs the new key",
        code: "KEY_REQUIRED",
      });

    await this.prisma.$transaction(async (tx) => {
      // Conditional on the revision: a concurrent edit makes this a conflict, not a mix of keys.
      const r = await tx.vaultItem.updateMany({
        where: { id: itemId, vaultId: auth.vaultId, revision: dto.revision },
        data: {
          protectedItemKey: dto.protectedItemKey,
          rekeyNeeded: false,
          revision: { increment: 1 },
        },
      });
      if (r.count !== 1)
        throw new ConflictException({
          message: "This item changed on another device. Reload and try again.",
          code: "REVISION_CONFLICT",
        });
      for (const f of dto.fields)
        await tx.vaultItemField.updateMany({
          where: { itemId, key: f.key, sensitive: true },
          data: { value: f.value },
        });
      for (const v of versionUpdates)
        await tx.vaultItemVersion.update({ where: { id: v.id }, data: { fields: v.fields } });
      for (const [id, sealed] of seals)
        await tx.itemShare.update({
          where: { id },
          data: { sealedItemKey: sealed, sealedAt: new Date() },
        });
    });
    if (item.protectedItemKey) await this.activity.log(auth, "item.rekeyed", { item });
    return { revision: item.revision + 1 };
  }

  /** Shares the owner's client can complete now: the recipient has become able to receive them. */
  async pendingSeals(auth: AuthContext): Promise<PendingSeal[]> {
    const rows = await this.prisma.itemShare.findMany({
      where: {
        ownerId: auth.userId,
        sealedItemKey: null,
        item: { vaultId: auth.vaultId, deletedAt: null, protectedItemKey: { not: null } },
        AND: [notExpired()],
      },
      include: { item: { select: { id: true, name: true, protectedItemKey: true } } },
      take: 200,
    });
    const ready = await this.readyRecipients(rows.map((r) => r.email));
    return rows.flatMap((r) => {
      const user = ready.get(r.email);
      if (!user) return [];
      return [
        {
          shareId: r.id,
          itemId: r.item.id,
          itemName: r.item.name,
          protectedItemKey: r.item.protectedItemKey!,
          recipient: user,
        },
      ];
    });
  }

  async completeSeal(auth: AuthContext, shareId: string, dto: CompleteSealDto) {
    const share = await this.prisma.itemShare.findFirst({
      where: { id: shareId, ownerId: auth.userId, item: { vaultId: auth.vaultId } },
      include: { item: { select: { id: true, name: true, type: true, protectedItemKey: true } } },
    });
    if (!share) throw new NotFoundException("Share not found");
    if (share.item.protectedItemKey !== dto.protectedItemKey)
      throw new ConflictException({
        message: "The item's key changed. Try again.",
        code: "ITEM_KEY_CHANGED",
      });
    const ready = (await this.readyRecipients([share.email])).get(share.email);
    if (!ready || ready.id !== dto.recipientUserId)
      throw new BadRequestException({
        message: "That person can't receive it yet",
        code: "RECIPIENT_CHANGED",
      });
    // Only an unsealed share: a sealed one is never re-pointed at another account.
    const r = await this.prisma.itemShare.updateMany({
      where: { id: share.id, sealedItemKey: null },
      data: { recipientId: ready.id, sealedItemKey: dto.sealedItemKey, sealedAt: new Date() },
    });
    if (r.count !== 1) throw new ConflictException("Already handed over");
  }

  // ─── Recipient ─────────────────────────────────────────────────────────────

  /** Shares addressed to the caller: sealed to them, or waiting for their verified email. */
  private async recipientWhere(auth: AuthContext): Promise<Prisma.ItemShareWhereInput> {
    const me = await this.me(auth.userId);
    return {
      item: { deletedAt: null },
      AND: [
        notExpired(),
        {
          OR: [
            { recipientId: auth.userId },
            ...(me.emailVerifiedAt ? [{ recipientId: null, email: me.email }] : []),
          ],
        },
      ],
    };
  }

  /** What a recipient may see of the owner's item: never their projects, collections or tags. */
  private recipientSummary(s: VaultItemSummary): VaultItemSummary {
    return {
      ...s,
      project: null,
      collection: null,
      tags: [],
      favorite: false,
      sharedWith: undefined,
      accessCount: 0,
    };
  }

  async sharedWithMe(auth: AuthContext): Promise<SharedWithMeItem[]> {
    const rows = await this.prisma.itemShare.findMany({
      where: await this.recipientWhere(auth),
      include: { item: { include: SUMMARY_INCLUDE }, owner: PERSON },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return rows.map((r) => ({
      ...this.recipientSummary(toSummary(r.item)),
      shareId: r.id,
      permission: r.permission,
      sharedBy: r.owner,
      sharedAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      status: r.sealedItemKey ? "active" : "waiting",
      isNew: !r.seenAt,
    }));
  }

  /** Active shares to the caller whose items match `items` (extension: site match, search). */
  private async activeShared(auth: AuthContext, items: Prisma.VaultItemWhereInput, take: number) {
    const rows = await this.prisma.itemShare.findMany({
      where: {
        recipientId: auth.userId,
        sealedItemKey: { not: null },
        item: { deletedAt: null, ...items },
        AND: [notExpired()],
      },
      include: { item: { include: SUMMARY_INCLUDE }, owner: PERSON },
      orderBy: { item: { updatedAt: "desc" } },
      take,
    });
    return rows.map((r) => ({
      ...this.recipientSummary(toSummary(r.item)),
      shareId: r.id,
      permission: r.permission,
      sharedBy: r.owner,
      sharedAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      status: "active" as const,
      isNew: !r.seenAt,
    }));
  }

  /** Shared logins for the site the extension is on: the same public-suffix-aware rule as the vault. */
  async matchShared(auth: AuthContext, host: string): Promise<SharedWithMeItem[]> {
    const clean = normalizeHost(host);
    if (!clean) return [];
    const domain = registrableDomain(clean);
    const sameSite: Prisma.VaultItemWhereInput[] = domain
      ? [{ host: clean }, { host: domain }, { host: { endsWith: `.${domain}` } }]
      : [{ host: clean }];
    const rows = await this.activeShared(auth, { OR: sameSite }, 20);
    return rows
      .filter((i) => matchHost(i.host, clean) !== null)
      .sort((a, b) => Number(b.host === clean) - Number(a.host === clean));
  }

  async searchShared(auth: AuthContext, q: string): Promise<SharedWithMeItem[]> {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!terms.length) return [];
    return this.activeShared(
      auth,
      { AND: terms.map((t) => ({ searchText: { contains: t, mode: "insensitive" as const } })) },
      10,
    );
  }

  /** An active share of this item to the caller, or 404. */
  private async received(auth: AuthContext, itemId: string, need: "VIEW" | "EDIT" = "VIEW") {
    const share = await this.prisma.itemShare.findFirst({
      where: {
        itemId,
        recipientId: auth.userId,
        sealedItemKey: { not: null },
        item: { deletedAt: null },
        AND: [notExpired()],
      },
      include: { owner: PERSON, item: { select: { vaultId: true, name: true, type: true } } },
    });
    if (!share) throw new NotFoundException("Item not found");
    if (need === "EDIT" && share.permission !== "EDIT")
      throw new ForbiddenException("You can use this item but not change it");
    // The owner's vault, for the shared ItemsService; activity stays the caller's.
    const scoped: AuthContext = { ...auth, vaultId: share.item.vaultId };
    return { share, scoped };
  }

  async getShared(auth: AuthContext, itemId: string): Promise<SharedItemDetail> {
    const { share, scoped } = await this.received(auth, itemId);
    const detail = await this.items.get(scoped, itemId);
    if (!share.seenAt)
      await this.prisma.itemShare.update({ where: { id: share.id }, data: { seenAt: new Date() } });
    return {
      ...detail,
      ...this.recipientSummary(detail),
      relations: [],
      usedBy: [],
      // History holds earlier secrets, which the owner did not share.
      versionCount: 0,
      protectedItemKey: null,
      shareId: share.id,
      permission: share.permission,
      sharedBy: share.owner,
      sharedAt: share.createdAt.toISOString(),
      expiresAt: share.expiresAt?.toISOString() ?? null,
      sealedItemKey: share.sealedItemKey!,
    };
  }

  /**
   * An edit by a recipient with EDIT permission. Only the fields, name and
   * description: how the owner organises the item (project, collection,
   * tags, favorite) is theirs and kept as it is.
   */
  async updateShared(auth: AuthContext, itemId: string, dto: UpsertItemDto) {
    const { share, scoped } = await this.received(auth, itemId, "EDIT");
    const existing = await this.prisma.vaultItem.findUniqueOrThrow({
      where: { id: itemId },
      include: { tags: { include: { tag: true } }, usedBy: true },
    });
    const summary = await this.items.update(scoped, itemId, {
      ...dto,
      projectId: existing.projectId,
      collectionId: existing.collectionId,
      favorite: existing.favorite,
      tags: existing.tags.map((t) => t.tag.name),
      usedByProjectIds: existing.usedBy.map((u) => u.projectId),
      // A reuse fingerprint is keyed by the owner's vault key, which the recipient does not have.
      signals: dto.signals ? { ...dto.signals, passwordFingerprint: undefined } : undefined,
    });
    // The owner sees who changed their item.
    await this.activity.log({ userId: share.ownerId }, "item.updated", {
      item: { id: itemId, name: summary.name, type: summary.type },
      metadata: { member: (await this.me(auth.userId)).email, via: "share" },
    });
    return this.recipientSummary(summary);
  }

  async usage(auth: AuthContext, itemId: string, action: Action, field?: string) {
    const { scoped } = await this.received(auth, itemId);
    await this.items.recordUsage(scoped, itemId, action, field);
  }

  /** The recipient removes an item from Shared with me. */
  async leave(auth: AuthContext, shareId: string) {
    const share = await this.prisma.itemShare.findFirst({
      where: { id: shareId, ...(await this.recipientWhere(auth)) },
      include: { item: { select: { id: true, name: true, type: true } } },
    });
    if (!share) throw new NotFoundException("Share not found");
    await this.prisma.$transaction([
      this.prisma.itemShare.delete({ where: { id: share.id } }),
      ...(share.sealedItemKey
        ? [
            this.prisma.vaultItem.update({
              where: { id: share.itemId },
              data: { rekeyNeeded: true },
            }),
          ]
        : []),
    ]);
    await this.activity.log({ userId: share.ownerId }, "item.access_removed", {
      item: share.item,
      metadata: { member: share.email, via: "left" },
    });
  }
}
