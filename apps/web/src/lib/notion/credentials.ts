import {
  findSecrets,
  getItemType,
  normalizeHost,
  parseGenericRows,
  smartFill,
} from "@minions/core";

/**
 * Finds credentials in imported Notion content so they become vault items
 * (with history, the Security Center and autofill) instead of staying as
 * text in a page. Works on lines of text: Markdown lines, or the text of
 * each block of an HTML page. Everything here runs on the device.
 */

export interface CredentialSpan {
  line: number;
  /** The exact text to take out of that line (as written in the source). */
  raw: string;
  /** Replace the whole line (code blocks holding a key). */
  whole?: boolean;
}

export interface Credential {
  id: string;
  nodeKey: string;
  source: "row" | "text" | "table" | "code";
  type: string;
  name: string;
  /** Registry field key → plaintext. Memory only; encrypted when written. */
  values: Record<string, string>;
  spans: CredentialSpan[];
  /** Database rows: the columns that held secrets, dropped from the row page. */
  secretColumns?: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const SECRET_LABELS = new Set(
  [
    "password",
    "pass",
    "passwd",
    "pwd",
    "pw",
    "passcode",
    "passphrase",
    "pin",
    "api key",
    "apikey",
    "api secret",
    "key",
    "secret",
    "secret key",
    "client secret",
    "token",
    "access token",
    "api token",
    "auth token",
    "private key",
    "2fa",
    "2fa secret",
    "totp",
    "otp",
    "mfa",
    "backup codes",
    "recovery codes",
    "connection string",
    "database url",
    "dsn",
    "cvv",
    "cvc",
  ].map(norm),
);

const OTHER_LABELS = new Set(
  [
    "user",
    "username",
    "user name",
    "login",
    "userid",
    "user id",
    "email",
    "e-mail",
    "mail",
    "email address",
    "url",
    "website",
    "site",
    "link",
    "login url",
    "host",
    "hostname",
    "server",
    "ip",
    "port",
    "database",
    "db",
    "account",
    "account id",
    "name",
    "provider",
    "service",
    "environment",
    "env",
    "region",
    "client id",
  ].map(norm),
);

/** Undoes Markdown backslash escapes (Notion escapes `*`, `_`, `\`…). */
export const unescapeMd = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, "$1");

// "Password: x", "- **Email**: x", "1. API key = x"
const LABEL_LINE =
  /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?([A-Za-z][A-Za-z0-9 ./_-]{0,30}?)(?:\*\*|__)?\s*(?::|=|\s[-–]\s)\s*(.+?)\s*$/;

function labelOf(line: string): { label: string; raw: string; secret: boolean } | null {
  const m = line.match(LABEL_LINE);
  if (!m) return null;
  const label = norm(m[1]!);
  const raw = m[2]!.replace(/^(\*\*|__|`)|(\*\*|__|`)$/g, "").trim();
  if (!raw) return null;
  if (SECRET_LABELS.has(label)) return { label, raw, secret: true };
  if (OTHER_LABELS.has(label)) return { label, raw, secret: false };
  return null;
}

const isHeading = (line: string) => /^\s*#{1,6}\s/.test(line);
const headingText = (line: string) =>
  unescapeMd(line.replace(/^\s*#{1,6}\s+/, "").replace(/[*_`]/g, "")).trim();
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** The best vault type for a group, falling back on what its secret is. */
function settle(type: string, values: Record<string, string>): string {
  if (getItemType(type) && type !== "SECURE_NOTE") return type;
  if (values.password) return "LOGIN";
  if (values.api_key) return "API_KEY";
  if (values.private_key) return "SSH_KEY";
  return "SECRET";
}

/** Keeps only fields the type has, and makes sure the secret landed somewhere. */
function fitFields(
  type: string,
  values: Record<string, string>,
  secret: string,
): Record<string, string> {
  const def = getItemType(type)!;
  const out: Record<string, string> = {};
  for (const f of def.fields) if (values[f.key]) out[f.key] = values[f.key]!;
  const hasSecret = def.fields.some((f) => f.sensitive && out[f.key]);
  if (!hasSecret) {
    const target = def.fields.find((f) => f.sensitive && f.kind !== "totp");
    if (target) out[target.key] = secret;
  }
  return out;
}

export function detectCredentials(
  lines: string[],
  ctx: { nodeKey: string; title: string; nextId: () => string },
): Credential[] {
  const found: Credential[] = [];
  const used = new Set<number>();
  let heading = ctx.title;
  const nameFor = (fallback?: string) =>
    (fallback && fallback.length <= 80 ? fallback : "") || heading || ctx.title || "Imported";

  // 1. Code blocks holding a private key or a provider key.
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(```|~~~)/.test(lines[i]!)) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*(```|~~~)/.test(lines[j]!)) j++;
    const body = lines.slice(i + 1, j).join("\n");
    const hit = findSecrets(body).find((s) =>
      ["private_key", "api_key", "token", "connection_string"].includes(s.kind),
    );
    if (hit) {
      const type =
        hit.kind === "private_key"
          ? "SSH_KEY"
          : hit.kind === "connection_string"
            ? "SECRET"
            : "API_KEY";
      const values: Record<string, string> =
        type === "SSH_KEY"
          ? { private_key: body.trim() }
          : type === "API_KEY"
            ? { api_key: hit.value, provider: hit.provider ?? nameFor() }
            : { secret: hit.value };
      found.push({
        id: ctx.nextId(),
        nodeKey: ctx.nodeKey,
        source: "code",
        type,
        name: nameFor(hit.provider),
        values,
        spans: Array.from({ length: Math.min(j, lines.length - 1) - i + 1 }, (_, k) => ({
          line: i + k,
          raw: lines[i + k]!,
          whole: true,
        })),
      });
      for (let k = i; k <= Math.min(j, lines.length - 1); k++) used.add(k);
    }
    i = j;
  }

  // 2. Markdown tables with a secret column: each row is one credential.
  for (let i = 0; i + 1 < lines.length; i++) {
    if (
      used.has(i) ||
      !/^\s*\|.*\|\s*$/.test(lines[i]!) ||
      !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)
    )
      continue;
    const header = cells(lines[i]!);
    const secretCols = header
      .map((h, k) => (SECRET_LABELS.has(norm(h)) ? k : -1))
      .filter((k) => k >= 0);
    let j = i + 2;
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]!)) j++;
    if (secretCols.length) {
      for (let r = i + 2; r < j; r++) {
        const row = cells(lines[r]!);
        const raws = secretCols.map((k) => row[k] ?? "").filter((v) => v && v !== "-");
        if (!raws.length) continue;
        const obj = Object.fromEntries(header.map((h, k) => [h, unescapeMd(row[k] ?? "")]));
        const rec = parseGenericRows([obj])[0]!;
        const type = settle(rec.type, rec.fields);
        found.push({
          id: ctx.nextId(),
          nodeKey: ctx.nodeKey,
          source: "table",
          type,
          name: rec.name !== "Untitled" ? rec.name : nameFor(),
          values: fitFields(type, rec.fields, unescapeMd(raws[0]!)),
          spans: raws.map((raw) => ({ line: r, raw })),
        });
        used.add(r);
      }
    }
    i = j - 1;
  }

  // 3. "Label: value" groups (blank lines allowed in between, as Notion writes one block per line).
  let group: { line: number; label: string; raw: string; secret: boolean }[] = [];
  let groupHeading = heading;
  const flush = () => {
    const secrets = group.filter((g) => g.secret);
    if (secrets.length) {
      const text = group.map((g) => `${g.label}: ${unescapeMd(g.raw)}`).join("\n");
      const fill = smartFill(text);
      const type = settle(fill.type, fill.values);
      const host = normalizeHost(fill.values.url ?? "");
      found.push({
        id: ctx.nextId(),
        nodeKey: ctx.nodeKey,
        source: "text",
        type,
        name: fill.name || groupHeading || host || ctx.title || "Imported",
        values: fitFields(type, fill.values, unescapeMd(secrets[0]!.raw)),
        spans: secrets.map((s) => ({ line: s.line, raw: s.raw })),
      });
      for (const g of group) used.add(g.line);
    }
    group = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isHeading(line)) {
      flush();
      heading = headingText(line);
      groupHeading = heading;
      continue;
    }
    if (used.has(i)) {
      flush();
      continue;
    }
    if (!line.trim()) continue;
    const l = labelOf(line);
    if (l) {
      if (!group.length) groupHeading = heading;
      // A label seen again ("Username:" for a second account) starts a new credential.
      if (group.some((g) => g.label === l.label)) flush();
      group.push({ line: i, ...l });
    } else {
      flush();
    }
  }
  flush();

  // 4. Provider-shaped keys anywhere else in the text ("sk_live_…", "ghp_…", AWS ids).
  heading = ctx.title;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isHeading(line)) heading = headingText(line);
    if (used.has(i)) continue;
    for (const s of findSecrets(line)) {
      if (!["api_key", "token", "jwt"].includes(s.kind)) continue;
      found.push({
        id: ctx.nextId(),
        nodeKey: ctx.nodeKey,
        source: "text",
        type: "API_KEY",
        name: s.provider ? `${s.provider} key` : nameFor(),
        values: { api_key: s.value, provider: s.provider ?? nameFor() },
        spans: [{ line: i, raw: s.value }],
      });
    }
  }
  return found;
}

/** Database rows: a database is about credentials when a column is named like a secret. */
export function secretColumnsOf(columns: string[]): string[] {
  return columns.filter((c) => SECRET_LABELS.has(norm(c)));
}

export function detectRowCredential(
  row: Record<string, string>,
  columns: string[],
  ctx: { nodeKey: string; title: string; nextId: () => string },
): Credential | null {
  const secretCols = secretColumnsOf(columns).filter((c) => (row[c] ?? "").trim());
  if (!secretCols.length) return null;
  const rec = parseGenericRows([row])[0]!;
  const type = settle(rec.type, rec.fields);
  return {
    id: ctx.nextId(),
    nodeKey: ctx.nodeKey,
    source: "row",
    type,
    name: ctx.title || rec.name,
    values: fitFields(type, rec.fields, row[secretCols[0]!]!.trim()),
    spans: [],
    secretColumns: secretCols,
  };
}

/** What the preview shows: never the secret itself. */
export function describe(c: Credential): string {
  const v = c.values;
  const who = v.username || v.email || v.account || "";
  const where = normalizeHost(v.url ?? v.base_url ?? "") ?? v.provider ?? "";
  return [where, who].filter(Boolean).join(" · ") || getItemType(c.type)?.label || c.type;
}

/** The placeholder a secret is replaced with until the vault item exists. */
export const tokenFor = (id: string) => `⟦minions-vault:${id}⟧`;
export const TOKEN_RE = /⟦minions-vault:([a-z0-9]+)⟧/g;

/** Takes the secrets out of Markdown lines: each becomes a vault-item token. */
export function redactLines(lines: string[], creds: Credential[]): string[] {
  const out = [...lines];
  const drop = new Set<number>();
  for (const c of creds) {
    const whole = c.spans.filter((s) => s.whole);
    if (whole.length) {
      out[whole[0]!.line] = tokenFor(c.id);
      for (const s of whole.slice(1)) drop.add(s.line);
    }
    let first = true;
    for (const s of c.spans.filter((x) => !x.whole)) {
      const line = out[s.line] ?? "";
      const at = line.lastIndexOf(s.raw);
      if (at < 0) continue;
      // The first secret becomes the link to the item; any others just go.
      out[s.line] =
        line.slice(0, at) + (first ? tokenFor(c.id) : "•••") + line.slice(at + s.raw.length);
      first = false;
    }
  }
  return out.filter((_, i) => !drop.has(i));
}
