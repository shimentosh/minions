import {
  aad,
  cardBrand,
  decryptString,
  encryptString,
  estimateStrength,
  type FieldKind,
  getItemType,
  type ItemField,
  resolveField,
  secretFingerprint,
  type UpsertItemRequest,
  type VaultItemDetail,
} from "@minions/core";
import { itemKeyFor } from "./item-keys";
import { requireVaultKey } from "./session";

/** A workspace item's own key when this client opened one, else the personal vault key. */
function keyFor(itemId: string) {
  return itemKeyFor(itemId) ?? requireVaultKey();
}

/** Decrypts one field, at the moment it is needed. */
export async function revealField(itemId: string, field: ItemField): Promise<string> {
  if (!field.sensitive) return field.value;
  return decryptString(keyFor(itemId), field.value, aad.field(itemId, field.key));
}

/** Every field in plaintext, for the editor only. */
export async function decryptAll(item: VaultItemDetail): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of item.fields) out[f.key] = await revealField(item.id, f);
  return out;
}

export interface CustomFieldInput {
  key: string;
  label: string;
  sensitive: boolean;
  kind?: FieldKind;
}

export interface ItemDraft {
  id: string;
  type: string;
  name: string;
  description?: string | null;
  projectId?: string | null;
  collectionId?: string | null;
  favorite?: boolean;
  tags?: string[];
  usedByProjectIds?: string[];
  /** Field key → plaintext. Empty strings are dropped. */
  values: Record<string, string>;
  custom?: CustomFieldInput[];
  revision?: number;
}

/**
 * Turns an edited draft into the wire format. Sensitive values are encrypted
 * here, with AAD binding each one to its item and field. A value the user did
 * not change keeps its existing envelope, so history only records real changes.
 */
export async function encryptDraft(
  draft: ItemDraft,
  original?: { item: VaultItemDetail; plain: Record<string, string> },
): Promise<UpsertItemRequest> {
  const key = keyFor(draft.id);
  const def = getItemType(draft.type);
  if (!def) throw new Error("Unknown item type");
  const customByKey = new Map((draft.custom ?? []).map((c) => [c.key, c]));
  const fields: ItemField[] = [];

  for (const [fieldKey, raw] of Object.entries(draft.values)) {
    const value = raw.trim() === "" ? "" : raw;
    if (!value) continue;
    const custom = customByKey.get(fieldKey);
    const resolved = resolveField(
      draft.type,
      fieldKey,
      custom ? { label: custom.label, sensitive: custom.sensitive, kind: custom.kind } : undefined,
    );
    if (!resolved) continue;
    const sensitive = resolved.def.sensitive;
    let stored = value;
    if (sensitive) {
      const before = original?.item.fields.find((f) => f.key === fieldKey);
      stored =
        before?.sensitive && original!.plain[fieldKey] === value
          ? before.value
          : await encryptString(key, value, aad.field(draft.id, fieldKey));
    }
    fields.push({
      key: fieldKey,
      value: stored,
      sensitive,
      ...(custom ? { label: custom.label, kind: custom.kind ?? "text" } : {}),
    });
  }

  const signals: UpsertItemRequest["signals"] = {};
  const pw = def.passwordField ? draft.values[def.passwordField] : undefined;
  if (pw) {
    signals.passwordStrength = estimateStrength(pw).score;
    // Reuse detection compares personal passwords only.
    if (!itemKeyFor(draft.id)) signals.passwordFingerprint = await secretFingerprint(key, pw);
  }
  if (draft.type === "CREDIT_CARD" && draft.values.number) {
    const digits = draft.values.number.replace(/\D/g, "");
    if (digits.length >= 4) signals.cardLast4 = digits.slice(-4);
    const brand = cardBrand(digits);
    if (brand) signals.cardBrand = brand;
  }

  return {
    id: draft.id,
    type: draft.type,
    name: draft.name.trim() || def.label,
    description: draft.description?.trim() || null,
    projectId: draft.projectId ?? null,
    collectionId: draft.collectionId ?? null,
    favorite: draft.favorite ?? false,
    tags: draft.tags ?? [],
    usedByProjectIds: draft.usedByProjectIds ?? [],
    fields,
    signals,
    ...(draft.revision ? { revision: draft.revision } : {}),
  };
}

export async function encryptNote(noteId: string, html: string): Promise<string> {
  return encryptString(requireVaultKey(), html, aad.note(noteId));
}

export async function decryptNote(noteId: string, envelope: string | null): Promise<string> {
  if (!envelope) return "";
  return decryptString(requireVaultKey(), envelope, aad.note(noteId));
}
