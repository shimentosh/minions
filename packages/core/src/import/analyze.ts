import { registrableDomain } from "../url";
import type { ImportRecord } from "./normalize";

/** Services that sign in with one parent account. */
export const ACCOUNT_FAMILIES: Record<string, { canonical: string; members: RegExp }> = {
  google: {
    canonical: "Google Account",
    members:
      /\b(google|gmail|youtube|google drive|drive|analytics|search console|adsense|google ads|google cloud|firebase|play console)\b/i,
  },
  microsoft: {
    canonical: "Microsoft Account",
    members: /\b(microsoft|outlook|hotmail|live|xbox|office|onedrive|azure|skype|teams)\b/i,
  },
  apple: { canonical: "Apple ID", members: /\b(apple|icloud|app store|itunes|apple id)\b/i },
  meta: { canonical: "Meta Account", members: /\b(facebook|instagram|whatsapp|messenger|meta)\b/i },
  amazon: { canonical: "Amazon Account", members: /\b(amazon|aws|kindle|audible|prime)\b/i },
};

export interface ImportGroup {
  canonical: string;
  family: string;
  identity: string;
  /** The record to keep as the canonical login (has the password). */
  primaryRef: string;
  /** Records that look like services or parts of the same account. */
  memberRefs: string[];
}

export interface DuplicateGroup {
  key: string;
  refs: string[];
  /** Same host+identity with the same password, or different ones. */
  samePassword: boolean;
}

export interface ExistingItemSummary {
  id: string;
  name: string;
  type: string;
  host: string | null;
  username: string | null;
}

export interface ImportAnalysis {
  total: number;
  byType: Record<string, number>;
  incomplete: number;
  invalidUrls: number;
  duplicatesInFile: DuplicateGroup[];
  /** ref → existing vault item ids it probably duplicates. */
  duplicatesOfExisting: Record<string, string[]>;
  groups: ImportGroup[];
}

const identity = (r: ImportRecord) =>
  (r.fields.email || r.fields.username || r.fields.account || "").toLowerCase();

export function analyzeImport(
  records: ImportRecord[],
  existing: ExistingItemSummary[] = [],
): ImportAnalysis {
  const byType: Record<string, number> = {};
  for (const r of records) byType[r.type] = (byType[r.type] ?? 0) + 1;

  // Duplicates inside the file: same registrable domain and identity.
  const buckets = new Map<string, ImportRecord[]>();
  for (const r of records) {
    if (!r.host) continue;
    const key = `${registrableDomain(r.host) ?? r.host}|${identity(r)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }
  const duplicatesInFile: DuplicateGroup[] = [...buckets.entries()]
    .filter(([, rs]) => rs.length > 1)
    .map(([key, rs]) => ({
      key,
      refs: rs.map((r) => r.ref),
      samePassword: new Set(rs.map((r) => r.fields.password ?? "")).size === 1,
    }));

  const duplicatesOfExisting: Record<string, string[]> = {};
  for (const r of records) {
    const id = identity(r);
    const matches = existing.filter((e) => {
      const sameIdentity = (e.username ?? "").toLowerCase() === id;
      if (r.host && e.host)
        return (
          (registrableDomain(r.host) ?? r.host) === (registrableDomain(e.host) ?? e.host) &&
          sameIdentity
        );
      return e.type === r.type && e.name.toLowerCase() === r.name.toLowerCase() && sameIdentity;
    });
    if (matches.length) duplicatesOfExisting[r.ref] = matches.map((m) => m.id);
  }

  // Families: "Google password", "Gmail login", "YouTube", "Google 2FA",
  // "Backup codes" for the same address → one Google Account.
  const groups: ImportGroup[] = [];
  for (const [family, def] of Object.entries(ACCOUNT_FAMILIES)) {
    const byIdentity = new Map<string, ImportRecord[]>();
    for (const r of records) {
      const hay = `${r.name} ${r.host ?? ""} ${r.fields.provider ?? ""} ${r.fields.issuer ?? ""} ${r.fields.service ?? ""}`;
      if (!def.members.test(hay)) continue;
      const id = identity(r);
      if (!id) continue;
      byIdentity.set(id, [...(byIdentity.get(id) ?? []), r]);
    }
    for (const [id, rs] of byIdentity) {
      if (rs.length < 2) continue;
      const primary = rs.find((r) => r.type === "LOGIN" && r.fields.password) ?? rs[0]!;
      groups.push({
        canonical: def.canonical,
        family,
        identity: id,
        primaryRef: primary.ref,
        memberRefs: rs.filter((r) => r !== primary).map((r) => r.ref),
      });
    }
  }

  return {
    total: records.length,
    byType,
    incomplete: records.filter((r) => r.issues.some((i) => i !== "invalid_url")).length,
    invalidUrls: records.filter((r) => r.issues.includes("invalid_url")).length,
    duplicatesInFile,
    duplicatesOfExisting,
    groups,
  };
}
