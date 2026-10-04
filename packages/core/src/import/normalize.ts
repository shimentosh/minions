import { classify } from "../classify";
import { cardBrand, findSecrets, luhnValid } from "../detect";
import { getItemType } from "../item-types";
import { isValidTotp } from "../totp";
import { normalizeHost } from "../url";
import { csvToObjects } from "./csv";

export type ImportSource =
  | "chrome"
  | "firefox"
  | "bitwarden-csv"
  | "bitwarden-json"
  | "notion"
  | "csv"
  | "json";

export interface ImportRecord {
  /** Stable within one import, for selections in the preview. */
  ref: string;
  type: string;
  name: string;
  /** Registry field key → plaintext value. Encrypted just before saving. */
  fields: Record<string, string>;
  host: string | null;
  folder?: string;
  tags: string[];
  favorite: boolean;
  issues: ("invalid_url" | "missing_password" | "missing_username" | "unknown_type" | "empty")[];
  sourceRow: number;
}

const pick = (row: Record<string, string>, ...names: string[]): string => {
  const lower = new Map(
    Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/[\s_-]+/g, ""), v]),
  );
  for (const n of names) {
    const v = lower.get(n.toLowerCase().replace(/[\s_-]+/g, ""));
    if (v?.trim()) return v.trim();
  }
  return "";
};

const TYPE_ALIASES: Record<string, string> = {
  login: "LOGIN",
  password: "LOGIN",
  website: "LOGIN",
  account: "LOGIN",
  "api key": "API_KEY",
  api: "API_KEY",
  apikey: "API_KEY",
  token: "API_KEY",
  secret: "SECRET",
  server: "SERVER",
  vps: "SERVER",
  ssh: "SSH_KEY",
  "ssh key": "SSH_KEY",
  database: "DATABASE",
  db: "DATABASE",
  cloud: "CLOUD",
  "2fa": "TOTP",
  totp: "TOTP",
  "backup codes": "RECOVERY_CODE",
  "recovery codes": "RECOVERY_CODE",
  license: "LICENSE",
  webhook: "WEBHOOK",
  env: "ENVIRONMENT",
  card: "CREDIT_CARD",
  "credit card": "CREDIT_CARD",
  bank: "BANK_ACCOUNT",
  "bank account": "BANK_ACCOUNT",
  payment: "PAYMENT_ACCOUNT",
  note: "SECURE_NOTE",
  "secure note": "SECURE_NOTE",
  domain: "DOMAIN",
};

function finish(r: Omit<ImportRecord, "issues" | "host"> & { host?: string | null }): ImportRecord {
  const issues: ImportRecord["issues"] = [];
  const def = getItemType(r.type);
  if (!def) issues.push("unknown_type");
  const url = r.fields.url ?? r.fields.base_url ?? r.fields.console_url;
  const host = r.host ?? normalizeHost(url);
  if (url && !host) issues.push("invalid_url");
  if (r.type === "LOGIN") {
    if (!r.fields.password) issues.push("missing_password");
    if (!r.fields.username && !r.fields.email) issues.push("missing_username");
  }
  if (Object.values(r.fields).every((v) => !v)) issues.push("empty");
  // Drop empty values; keep only keys the type knows about.
  const fields = Object.fromEntries(
    Object.entries(r.fields).filter(
      ([k, v]) => v && (def?.fields.some((f) => f.key === k) ?? false),
    ),
  );
  return { ...r, fields, host, issues };
}

function loginFrom(
  row: Record<string, string>,
  i: number,
  extra: Partial<ImportRecord> = {},
): ImportRecord {
  const url = pick(row, "url", "login_uri", "website", "site", "link", "uri");
  const user = pick(row, "username", "login_username", "login", "user", "user name");
  const email = pick(row, "email", "e-mail", "mail");
  const host = normalizeHost(url);
  return finish({
    ref: `r${i}`,
    type: "LOGIN",
    name: pick(row, "name", "title") || host || "Untitled login",
    fields: {
      url,
      username: user?.includes("@") && !email ? "" : user,
      email: email || (user.includes("@") ? user : ""),
      password: pick(row, "password", "login_password", "pass"),
      totp: pick(row, "totp", "login_totp", "otp", "2fa secret", "otpauth"),
      notes: pick(row, "note", "notes", "comments", "extra"),
    },
    tags: [],
    favorite: false,
    sourceRow: i + 2,
    ...extra,
  });
}

export function parseChromeCsv(text: string): ImportRecord[] {
  return csvToObjects(text).map((row, i) => loginFrom(row, i));
}

export function parseFirefoxCsv(text: string): ImportRecord[] {
  return csvToObjects(text).map((row, i) =>
    loginFrom(row, i, { name: normalizeHost(pick(row, "url")) ?? "Untitled login" }),
  );
}

export function parseBitwardenCsv(text: string): ImportRecord[] {
  return csvToObjects(text).map((row, i) => {
    const kind = pick(row, "type");
    const base = {
      folder: pick(row, "folder") || undefined,
      favorite: pick(row, "favorite") === "1",
    };
    if (kind === "note") {
      return finish({
        ref: `r${i}`,
        type: "SECURE_NOTE",
        name: pick(row, "name") || "Untitled note",
        fields: { content: pick(row, "notes") },
        tags: [],
        sourceRow: i + 2,
        ...base,
      });
    }
    return loginFrom(row, i, base);
  });
}

interface BitwardenJson {
  folders?: { id: string; name: string }[];
  items?: {
    type: number;
    name?: string;
    notes?: string | null;
    favorite?: boolean;
    folderId?: string | null;
    login?: { uris?: { uri?: string }[]; username?: string; password?: string; totp?: string };
    card?: {
      cardholderName?: string;
      brand?: string;
      number?: string;
      expMonth?: string;
      expYear?: string;
      code?: string;
    };
  }[];
}

export function parseBitwardenJson(text: string): ImportRecord[] {
  const data = JSON.parse(text) as BitwardenJson;
  if (!Array.isArray(data.items)) throw new Error("Not a Bitwarden export");
  if ((data as { encrypted?: boolean }).encrypted)
    throw new Error("Encrypted Bitwarden exports are not supported; export unencrypted JSON");
  const folders = new Map((data.folders ?? []).map((f) => [f.id, f.name]));
  return data.items.map((item, i) => {
    const base = {
      ref: `r${i}`,
      name: item.name || "Untitled",
      tags: [],
      favorite: !!item.favorite,
      folder: item.folderId ? folders.get(item.folderId) : undefined,
      sourceRow: i + 1,
    };
    if (item.type === 3 && item.card) {
      return finish({
        ...base,
        type: "CREDIT_CARD",
        fields: {
          cardholder: item.card.cardholderName ?? "",
          number: item.card.number ?? "",
          exp_month: item.card.expMonth ?? "",
          exp_year: item.card.expYear ?? "",
          cvv: item.card.code ?? "",
          issuer: item.card.brand ?? "",
          notes: item.notes ?? "",
        },
      });
    }
    if (item.type === 2)
      return finish({ ...base, type: "SECURE_NOTE", fields: { content: item.notes ?? "" } });
    const login = item.login ?? {};
    const user = login.username ?? "";
    return finish({
      ...base,
      type: "LOGIN",
      fields: {
        url: login.uris?.[0]?.uri ?? "",
        username: user.includes("@") ? "" : user,
        email: user.includes("@") ? user : "",
        password: login.password ?? "",
        totp: login.totp ?? "",
        notes: item.notes ?? "",
      },
    });
  });
}

/**
 * A spreadsheet or Notion database of mixed credentials. Columns are mapped by
 * name, the type comes from a "type" column or is detected per row, and a
 * value that looks like a TOTP secret or a card number goes to the right field.
 */
export function parseGenericRows(rows: Record<string, string>[]): ImportRecord[] {
  return rows.map((row, i) => {
    const name = pick(row, "name", "title", "service", "account", "item");
    const explicitType = TYPE_ALIASES[pick(row, "type", "category", "kind").toLowerCase()];
    const url = pick(row, "url", "website", "link", "site", "login url");
    const host = normalizeHost(url);
    const password = pick(row, "password", "pass", "pwd");
    const secret = pick(row, "api key", "apikey", "key", "token", "secret", "value");
    const notes = pick(row, "notes", "note", "description", "comments", "details");
    const twofa = pick(row, "2fa", "totp", "otp", "2fa secret", "authenticator");
    const backup = pick(row, "backup codes", "recovery codes", "codes");
    const user = pick(row, "username", "user", "login");
    const email = pick(row, "email", "e-mail", "mail");
    const tags = pick(row, "tags", "labels")
      .split(/[,;]/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    let type = explicitType;
    if (!type) {
      const cardish = [secret, password, notes].find((v) => v && luhnValid(v));
      if (cardish) type = "CREDIT_CARD";
      else if (!password && twofa && isValidTotp(twofa)) type = "TOTP";
      else if (!password && backup) type = "RECOVERY_CODE";
      else type = classify({ name, host, text: `${name} ${pick(row, "type", "category")}` }).type;
      if (type === "SECURE_NOTE" && (password || user || email)) type = "LOGIN";
      if (secret && type === "LOGIN" && !password && findSecrets(secret).length) type = "API_KEY";
    }

    const fields: Record<string, string> = {};
    switch (type) {
      case "LOGIN":
        Object.assign(fields, {
          url,
          username: user,
          email,
          password: password || secret,
          notes,
          recovery_email: pick(row, "recovery email"),
        });
        if (twofa && isValidTotp(twofa)) fields.totp = twofa;
        else if (twofa) fields.notes = [notes, `2FA: ${twofa}`].filter(Boolean).join("\n");
        if (backup) fields.backup_codes = backup;
        break;
      case "API_KEY":
      case "SECRET":
        Object.assign(fields, {
          provider: pick(row, "provider") || classify({ name, host }).provider || name,
          [type === "API_KEY" ? "api_key" : "secret"]: secret || password,
          environment: pick(row, "environment", "env"),
          base_url: url,
          notes,
        });
        break;
      case "TOTP":
        Object.assign(fields, {
          issuer: name,
          account: email || user,
          totp: twofa || secret,
          notes,
        });
        break;
      case "RECOVERY_CODE":
        Object.assign(fields, {
          service: name,
          account: email || user,
          codes: backup || secret || notes,
        });
        break;
      case "CREDIT_CARD": {
        const number =
          [secret, password, pick(row, "card number", "number")].find((v) => v && luhnValid(v)) ??
          "";
        Object.assign(fields, {
          number,
          cardholder: pick(row, "cardholder", "holder"),
          cvv: pick(row, "cvv", "cvc", "security code"),
          issuer: pick(row, "issuer", "bank") || cardBrand(number) || "",
          notes,
        });
        break;
      }
      case "SECURE_NOTE":
        fields.content = [notes, secret, password].filter(Boolean).join("\n");
        break;
      default:
        Object.assign(fields, {
          url,
          username: user,
          email,
          password,
          notes,
          provider: pick(row, "provider") || name,
          host: pick(row, "host", "ip"),
          secret,
        });
    }
    return finish({
      ref: `r${i}`,
      type,
      name: name || host || "Untitled",
      fields,
      tags,
      favorite: false,
      folder: pick(row, "folder", "project", "collection") || undefined,
      sourceRow: i + 2,
    });
  });
}

export function detectCsvSource(text: string): ImportSource {
  const header = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0]!.toLowerCase();
  if (header.includes("login_uri") && header.includes("login_password")) return "bitwarden-csv";
  if (header.includes("httprealm") || header.includes("formactionorigin")) return "firefox";
  if (/^name,url,username,password(,note)?$/.test(header.replace(/\s/g, ""))) return "chrome";
  return "csv";
}

export function parseImport(
  text: string,
  source: ImportSource | "auto",
  filename = "",
): { source: ImportSource; records: ImportRecord[] } {
  let resolved: ImportSource;
  if (source === "auto") {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      resolved =
        trimmed.includes('"items"') && trimmed.includes('"login"') ? "bitwarden-json" : "json";
    } else resolved = detectCsvSource(text);
    if (resolved === "csv" && /notion/i.test(filename)) resolved = "notion";
  } else resolved = source;

  switch (resolved) {
    case "chrome":
      return { source: resolved, records: parseChromeCsv(text) };
    case "firefox":
      return { source: resolved, records: parseFirefoxCsv(text) };
    case "bitwarden-csv":
      return { source: resolved, records: parseBitwardenCsv(text) };
    case "bitwarden-json":
      return { source: resolved, records: parseBitwardenJson(text) };
    case "json": {
      const data = JSON.parse(text) as unknown;
      const rows = Array.isArray(data) ? data : (data as { items?: unknown[] }).items;
      if (!Array.isArray(rows)) throw new Error("Expected an array of records");
      const flat = rows.map((r) =>
        Object.fromEntries(
          Object.entries(r as Record<string, unknown>).map(([k, v]) => [
            k,
            v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v),
          ]),
        ),
      );
      return { source: resolved, records: parseGenericRows(flat) };
    }
    default:
      return { source: resolved, records: parseGenericRows(csvToObjects(text)) };
  }
}
