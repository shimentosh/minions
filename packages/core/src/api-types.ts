import type { KdfParams } from "./crypto";
import type { FieldKind } from "./item-types";

/** Wire types shared by the API and its clients. Secret values only ever appear as envelopes. */

export type ClientKind = "web" | "extension" | "desktop";

export interface DeviceInfo {
  /** Random id the client generates once and keeps. Not a secret. */
  clientDeviceId: string;
  name: string;
  kind: ClientKind;
}

export interface PreloginResponse {
  kdf: KdfParams;
}

export interface RegisterRequest {
  email: string;
  name: string;
  userId: string;
  vaultId: string;
  authKey: string;
  kdf: KdfParams;
  protectedUserKey: string;
  protectedVaultKey: string;
  device: DeviceInfo;
}

export interface LoginRequest {
  email: string;
  authKey: string;
  device: DeviceInfo;
}

export interface VaultKeys {
  userId: string;
  vaultId: string;
  kdf: KdfParams;
  protectedUserKey: string;
  protectedVaultKey: string;
  /**
   * Set while a vault-key rotation is unfinished: the new vault key, wrapped by
   * the user key. A client that can unwrap it finishes the rotation.
   */
  pendingProtectedVaultKey?: string | null;
  /** Sharing key pair (see asym.ts). Null until the client first creates one. */
  publicKey?: string | null;
  protectedPrivateKey?: string | null;
}

export interface AuthResult {
  status: "ok" | "two_factor_required";
  /** Second factors the account can use, when status is two_factor_required. */
  methods?: ("totp" | "passkey")[];
  /** Only for bearer clients (extension, desktop). Web gets an HttpOnly cookie. */
  token?: string;
  keys?: VaultKeys;
}

export interface UserSettings {
  autoLockMinutes: number;
  clipboardClearSeconds: number;
  aiEnabled: boolean;
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    /** Whether the person proved they receive mail at `email`. */
    emailVerified: boolean;
    name: string;
    twoFactorEnabled: boolean;
    passkeyCount: number;
    createdAt: string;
    previousVisitAt: string | null;
  } & UserSettings;
  session: {
    id: string;
    vaultUnlocked: boolean;
    vaultUnlockedUntil: string | null;
  };
  vaultId: string;
}

export interface ItemField {
  key: string;
  /** Plaintext for non-sensitive fields, an envelope for sensitive ones. */
  value: string;
  sensitive: boolean;
  /** Custom fields only. */
  label?: string;
  kind?: FieldKind;
}

export interface SecretSignals {
  passwordStrength?: number;
  passwordFingerprint?: string;
  /** Set when the password value itself changed (the client knows; the server compares envelopes). */
  cardLast4?: string;
  cardBrand?: string;
}

export interface NamedRef {
  id: string;
  name: string;
  color?: string | null;
}

export interface VaultItemSummary {
  id: string;
  type: string;
  name: string;
  description: string | null;
  subtitle: string | null;
  host: string | null;
  username: string | null;
  provider: string | null;
  environment: string | null;
  status: string | null;
  favorite: boolean;
  project: NamedRef | null;
  collection: NamedRef | null;
  tags: string[];
  hasTotp: boolean;
  passwordStrength: number | null;
  cardLast4: string | null;
  cardBrand: string | null;
  expiresAt: string | null;
  lastRotatedAt: string | null;
  passwordUpdatedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Personal items: how many people it is shared with (pending invitations included). */
  sharedWith?: number;
}

export interface ItemRelation {
  id: string;
  kind: RelationKind;
  direction: "outgoing" | "incoming";
  item: Pick<VaultItemSummary, "id" | "name" | "type" | "subtitle">;
}

export type RelationKind =
  | "USED_FOR"
  | "SERVICE_OF"
  | "RECOVERY_FOR"
  | "TWO_FACTOR_FOR"
  | "RELATED";

export const RELATION_LABELS: Record<RelationKind, { outgoing: string; incoming: string }> = {
  USED_FOR: { outgoing: "Used for", incoming: "Signs in with" },
  SERVICE_OF: { outgoing: "Service of", incoming: "Services" },
  RECOVERY_FOR: { outgoing: "Recovery for", incoming: "Recovery" },
  TWO_FACTOR_FOR: { outgoing: "2FA for", incoming: "2FA" },
  RELATED: { outgoing: "Related", incoming: "Related" },
};

export interface VaultItemDetail extends VaultItemSummary {
  fields: ItemField[];
  relations: ItemRelation[];
  usedBy: NamedRef[];
  versionCount: number;
  /**
   * Personal items shared with people have their own key, wrapped by the vault
   * key (AAD keyAad.itemKeyForVault). Null: the fields are under the vault key.
   */
  protectedItemKey?: string | null;
  /** Someone who held this item's key lost access; its key should be replaced. */
  rekeyNeeded?: boolean;
}

export interface UpsertItemRequest {
  id: string;
  type: string;
  name: string;
  description?: string | null;
  projectId?: string | null;
  collectionId?: string | null;
  favorite?: boolean;
  tags?: string[];
  fields: ItemField[];
  signals?: SecretSignals;
  usedByProjectIds?: string[];
  /** Optimistic concurrency: the revision the edit was based on. */
  revision?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface ItemVersion {
  id: string;
  revision: number;
  createdAt: string;
  changedKeys: string[];
  /** Envelopes of the previous values. Decrypt with the item's field AAD. */
  fields: ItemField[];
}

export interface NoteSummary {
  id: string;
  title: string;
  pinned: boolean;
  favorite: boolean;
  archived: boolean;
  project: NamedRef | null;
  collection: NamedRef | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number;
}

export interface NoteDetail extends NoteSummary {
  contentEnc: string | null;
}

export type FindingType =
  | "weak_password"
  | "reused_password"
  | "missing_2fa"
  | "old_password"
  | "expiring"
  | "expired"
  | "unused"
  | "incomplete"
  | "duplicate";

export interface SecurityFinding {
  key: string;
  type: FindingType;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  items: Pick<VaultItemSummary, "id" | "name" | "type" | "subtitle">[];
  /** Total items involved; `items` may be a sample for very large groups. */
  itemCount?: number;
  dismissed: boolean;
}

export interface SecurityScoreFactor {
  label: string;
  ok: boolean;
  detail: string;
  weight: number;
  score: number;
}

export interface SecurityOverview {
  score: number | null;
  factors: SecurityScoreFactor[];
  /** Items affected per type, open findings only. */
  counts: Partial<Record<FindingType, number>>;
  /** Number of findings per type (open and dismissed); `findings` holds the first page of each. */
  findingTotals: Partial<Record<FindingType, number>>;
  findings: SecurityFinding[];
  totalItems: number;
  computedAt: string;
  /** A newer result is being computed; this one may be a few moments old. */
  refreshing?: boolean;
}

export interface ActivityEntry {
  id: string;
  action: string;
  itemId: string | null;
  itemName: string | null;
  itemType: string | null;
  device: string | null;
  ip: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  /** Who did it. Set in workspace audit logs, where entries come from several people. */
  actor?: { id: string; name: string; email: string } | null;
}

export interface DashboardSummary {
  sinceLastVisit: {
    since: string | null;
    created: number;
    updated: number;
    devices: number;
    openIssues: number;
  };
  favorites: VaultItemSummary[];
  recent: VaultItemSummary[];
  frequent: (VaultItemSummary & { accessCount: number })[];
  neverUsedCount: number;
  projects: (NamedRef & { itemCount: number })[];
  activity: ActivityEntry[];
}

export interface AiClassifyRequest {
  /** Every field is metadata; the server sanitises again regardless. */
  text?: string;
  name?: string;
  host?: string;
  provider?: string;
  typeHint?: string;
}

export interface AiClassifyResponse {
  available: boolean;
  classification?: {
    type: string;
    provider?: string;
    project?: string;
    collection?: string;
    environment?: string;
    tags: string[];
    confidence: number;
    reasons: string[];
    source: "rules" | "preferences" | "ai";
  };
  id?: string;
}

// ─── Workspaces and sharing ──────────────────────────────────────────────────

export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER";
/** INVITED: no account linked yet. ACCEPTED: joined, waiting for an admin to hand over the workspace key. */
export type MemberStatus = "INVITED" | "ACCEPTED" | "CONFIRMED";
export type ItemPermission = "VIEW" | "MANAGE";

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: WorkspaceRole;
  status: MemberStatus;
  memberCount: number;
  createdAt: string;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  /** The workspace key sealed to the caller. Null until an admin confirms them. */
  protectedWorkspaceKey: string | null;
  /** Members who joined and wait for an admin's client to seal them the workspace key. */
  pendingConfirmations: number;
  /** Someone with the workspace key left; an admin should rotate it. */
  rekeyNeeded: boolean;
  itemsNeedingRekey: number;
}

export interface WorkspaceMember {
  /** Membership id (also identifies a pending invitation). */
  id: string;
  userId: string | null;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  status: MemberStatus;
  /** Only once the member has joined. Compare fingerprints out of band. */
  publicKey: string | null;
  invitedAt: string;
  confirmedAt: string | null;
}

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  invitedBy: string | null;
  createdAt: string;
}

export interface ItemAccessGrant {
  userId: string;
  name: string;
  email: string;
  permission: ItemPermission;
  createdAt: string;
}

export interface WorkspaceItemSummary extends VaultItemSummary {
  workspaceId: string;
  /** The caller's permission. */
  permission: ItemPermission;
  workspaceShared: boolean;
  /** Members holding an explicit grant (the creator included). */
  grantCount: number;
  createdBy: { id: string; name: string } | null;
  rekeyNeeded: boolean;
}

/** How the caller opens this item's key. */
export interface ItemKeyEnvelope {
  /** "grant": sealed to the caller's public key. "workspace": wrapped by the workspace key. */
  source: "grant" | "workspace";
  wrapped: string;
}

export interface WorkspaceItemDetail extends VaultItemDetail {
  workspaceId: string;
  permission: ItemPermission;
  workspaceShared: boolean;
  grantCount: number;
  createdBy: { id: string; name: string } | null;
  rekeyNeeded: boolean;
  key: ItemKeyEnvelope;
}

export interface ItemAccessResponse {
  workspaceShared: boolean;
  grants: ItemAccessGrant[];
  permission: ItemPermission;
}

export interface AccessGrantInput {
  userId: string;
  permission: ItemPermission;
  /** Required for a member who has no grant yet: the item key sealed to their public key. */
  protectedItemKey?: string;
}

export interface UpdateItemAccessRequest {
  workspaceShared: boolean;
  /** Required when turning workspace sharing on: the item key wrapped by the workspace key. */
  workspaceWrappedKey?: string;
  grants: AccessGrantInput[];
}

export interface CreateWorkspaceItemRequest {
  item: UpsertItemRequest;
  access: UpdateItemAccessRequest;
}

/** A full re-key: new item key, every field re-encrypted, every grant re-sealed. */
export interface RekeyItemRequest {
  item: UpsertItemRequest;
  access: UpdateItemAccessRequest & { grants: Required<AccessGrantInput>[] };
}

export interface MemberProfile {
  member: WorkspaceMember;
  /** Credentials this member can open, limited to those the viewer can open too. */
  credentials: (Pick<WorkspaceItemSummary, "id" | "name" | "type" | "subtitle" | "host"> & {
    permission: ItemPermission;
    via: "grant" | "workspace";
  })[];
  /** For admins about to remove the member: items only this member can open. */
  soleAccessCount: number | null;
}

// ─── Operator dashboard ──────────────────────────────────────────────────────

/** Usage of the whole service. Counts only: nothing here is a vault value. */
export interface OperatorOverview {
  users: { total: number; new7d: number; new30d: number; twoFactor: number };
  /** Distinct accounts with a session active in the last day, week and month. */
  active: { day: number; week: number; month: number };
  signupsByDay: { day: string; count: number }[];
  items: { total: number; notes: number; byType: { type: string; count: number }[] };
  imports: {
    jobs: number;
    importedItems: number;
    bySource: { source: string; jobs: number; items: number }[];
  };
  workspaces: { total: number; members: number; sharedItems: number };
  devices: Partial<Record<"web" | "extension" | "desktop", number>>;
  generatedAt: string;
}

export interface OperatorUserRow {
  email: string;
  name: string;
  createdAt: string;
  lastActiveAt: string | null;
  items: number;
  imports: number;
  workspaces: number;
  twoFactor: boolean;
}

// ─── Sharing items with people ───────────────────────────────────────────────
//
// A personal item shared by email. The owner's client gives the item its own
// key and seals that key to each recipient's public key; someone without an
// account (or a verified email, or sharing keys yet) waits as "invited" until
// they can receive it, and the owner's client seals it the next time it is
// open. See ARCHITECTURE.md §8.

export type PeoplePermission = "VIEW" | "EDIT";

/**
 * invited: no verified account with sharing keys at this email yet.
 * ready:   the recipient can receive it; the owner's app hands over the key next time it is open.
 * active:  the recipient has the key.
 * expired: past its end date; the recipient no longer gets it.
 */
export type PeopleShareStatus = "invited" | "ready" | "active" | "expired";

export interface PersonRef {
  id: string;
  name: string;
  email: string;
}

/** The owner's view of one person an item is shared with. */
export interface PeopleShare {
  id: string;
  itemId: string;
  itemName: string;
  itemType: string;
  email: string;
  recipient: PersonRef | null;
  permission: PeoplePermission;
  status: PeopleShareStatus;
  /** null: never expires. */
  expiresAt: string | null;
  createdAt: string;
}

/** Whether an email belongs to someone who can receive a share right now. */
export interface ShareRecipientLookup {
  email: string;
  /** Present only when the account is verified and has sharing keys. */
  recipient: (PersonRef & { publicKey: string }) | null;
}

export interface CreatePeopleShareRequest {
  email: string;
  permission: PeoplePermission;
  /** 0 = never. */
  expiresInMinutes: number;
  /** With a recipient from the lookup: their id and the item key sealed to them. */
  recipientUserId?: string;
  sealedItemKey?: string;
}

/** Re-encrypted sensitive values, the way vault-key rotation sends them. */
export interface ReencryptedFields {
  fields: { key: string; value: string }[];
  versions: { id: string; fields: { key: string; value: string }[] }[];
}

/**
 * Moves a personal item onto its own key (first share) or a new key (after
 * someone lost access): every secret and version re-encrypted, the key
 * wrapped by the vault key, and re-sealed to everyone who keeps access.
 */
export interface SetItemKeyRequest extends ReencryptedFields {
  protectedItemKey: string;
  revision: number;
  seals: { shareId: string; sealedItemKey: string }[];
}

/** GET /vault/items/:id/item-key: what a re-key must re-encrypt, and who must get the new key. */
export interface ItemKeyMaterial extends ReencryptedFields {
  revision: number;
  protectedItemKey: string | null;
  holders: { shareId: string; email: string; userId: string; publicKey: string }[];
}

/** A share the owner's client can complete now: seal the item key to this person. */
export interface PendingSeal {
  shareId: string;
  itemId: string;
  itemName: string;
  protectedItemKey: string;
  recipient: PersonRef & { publicKey: string };
}

/** The recipient's view: an item someone shared with them. */
export interface SharedWithMeItem extends VaultItemSummary {
  shareId: string;
  permission: PeoplePermission;
  sharedBy: PersonRef;
  sharedAt: string;
  expiresAt: string | null;
  /** waiting: the owner's app has not handed over the key yet. */
  status: "active" | "waiting";
  /** Not opened yet. */
  isNew: boolean;
}

export interface SharedItemDetail extends VaultItemDetail {
  shareId: string;
  permission: PeoplePermission;
  sharedBy: PersonRef;
  sharedAt: string;
  expiresAt: string | null;
  /** The item key sealed to the caller (sealContext.itemKey). */
  sealedItemKey: string;
}
