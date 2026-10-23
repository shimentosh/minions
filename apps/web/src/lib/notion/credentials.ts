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
    "card number",
    "card no",
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

/** Labels that can carry the name of a service in front: "Gmail user", "AWS email". */
const QUALIFIABLE = new Set(
  ["user", "username", "user name", "login", "userid", "user id", "id", "email", "mail", "url"].map(
    norm,
  ),
);

/** Words in front of a label that say which account, not which service: "Admin password". */
const ROLE_WORDS = new Set(
  (
    "admin administrator root master main my new old current previous default login account " +
    "user app the primary personal work"
  ).split(" "),
);

/** "Recovery email", "Backup mail": go to the login's recovery field. */
const RECOVERY_WORDS = new Set(["recovery", "backup", "secondary", "alternate", "alternative"]);

/** Values that stand in for a secret rather than being one. */
const PLACEHOLDER =
  /^(?:n\/?a|none|nil|null|-+|—|tbd|todo|unknown|same(?: as (?:above|before|that))?|\?+|x{3,}|\*{3,}|•+|\.{3}|…|empty)$/i;

/** Undoes Markdown backslash escapes (Notion escapes `*`, `_`, `\`…). */
export const unescapeMd = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, "$1");

export interface Label {
  /** The label without its qualifier, normalized ("password", "apikey"). */
  label: string;
  /** The same, as written, for smart fill ("password", "api key"). */
  canon: string;
  /** The service written in front ("Gmail" in "Gmail password"), if any. */
  service: string;
  secret: boolean;
  /** The whole label is a known one, not a qualified one. */
  exact: boolean;
}

/**
 * What a label means: "Password", "Gmail password", "🔑 WiFi pass",
 * "Root password (new)", "Mail user". Null when it is not about a credential.
 */
export function classifyLabel(text: string): Label | null {
  const clean = unescapeMd(text)
    .replace(/\([^)]*\)/g, " ")
    .replace(/[*_`]/g, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  if (!clean || clean.length > 40) return null;
  const n = norm(clean);
  const lower = clean.toLowerCase();
  if (SECRET_LABELS.has(n))
    return { label: n, canon: lower, service: "", secret: true, exact: true };
  if (OTHER_LABELS.has(n))
    return { label: n, canon: lower, service: "", secret: false, exact: true };
  const words = clean.split(/[\s./_-]+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;
  // The longest known label at the end wins ("Stripe secret key" → "secret key").
  for (let k = Math.min(3, words.length - 1); k >= 1; k--) {
    const tailWords = words.slice(-k);
    const tail = norm(tailWords.join(" "));
    const front = words.slice(0, -k);
    const secret = SECRET_LABELS.has(tail);
    if (!secret && !QUALIFIABLE.has(tail)) continue;
    const frontLower = front.map((w) => w.toLowerCase());
    if (!secret && frontLower.length === 1 && RECOVERY_WORDS.has(frontLower[0]!)) {
      if (tail === "email" || tail === "mail")
        return {
          label: "recoveryemail",
          canon: "recovery email",
          service: "",
          secret,
          exact: false,
        };
    }
    const service = front.filter((w) => !ROLE_WORDS.has(w.toLowerCase())).join(" ");
    return { label: tail, canon: tailWords.join(" ").toLowerCase(), service, secret, exact: false };
  }
  return null;
}

/** Labels that fill the same field ("pass" and "password", "user" and "login"). */
const FIELD_OF: Record<string, string> = Object.fromEntries(
  (
    [
      ["password", ["password", "pass", "passwd", "pwd", "pw", "passcode", "passphrase"]],
      ["user", ["user", "username", "username", "login", "userid", "id"]],
      ["email", ["email", "e-mail", "mail", "emailaddress"]],
      ["url", ["url", "website", "site", "link", "loginurl"]],
    ] as const
  ).flatMap(([field, labels]) => labels.map((l) => [norm(l), field])),
);
const fieldOf = (label: string) => FIELD_OF[label] ?? label;

/** Whether a value can be what the label says: not a placeholder, not a sentence. */
function plausible(l: Label, raw: string): boolean {
  const v = unescapeMd(raw).trim();
  if (!v || PLACEHOLDER.test(v) || v.includes("⟦")) return false;
  if (!l.secret) return true;
  const words = v.split(/\s+/).length;
  // A passphrase can have a few words; prose ("Password: ask Sam for it") has more.
  if (l.label === "pass" && !l.exact) return words === 1;
  return words <= (l.exact ? 5 : 3);
}

// "Password: x", "- **Email**: x", "1. API key = x", "🔑 Gmail password – x"
const LABEL_LINE =
  /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?([^\s:=*_][^:=*_]{0,44}?)(?:\*\*|__)?\s*(?::|=|\s[-–]\s)\s*(.+?)\s*$/u;

type Found = Label & { raw: string };

function labelOf(line: string): Found | null {
  const m = line.match(LABEL_LINE);
  if (!m) return null;
  const l = classifyLabel(m[1]!);
  if (!l) return null;
  const raw = m[2]!.replace(/^(\*\*|__|`)+|(\*\*|__|`)+$/g, "").trim();
  return plausible(l, raw) ? { ...l, raw } : null;
}

/**
 * Why a line was not read as "label: value", as a reason code (diagnostics
 * for real exports; never the text itself).
 */
export function whyNotLabel(line: string): { reason: string; label?: string } {
  const m = line.match(LABEL_LINE);
  if (!m) return { reason: "no label: value shape" };
  const l = classifyLabel(m[1]!);
  if (!l) return { reason: "label not known", label: m[1]! };
  const raw = m[2]!.replace(/^(\*\*|__|`)+|(\*\*|__|`)+$/g, "").trim();
  if (plausible(l, raw)) return { reason: "read" };
  if (PLACEHOLDER.test(unescapeMd(raw).trim())) return { reason: "placeholder value" };
  return { reason: `value of ${raw.split(/\s+/).length} words`, label: m[1]! };
}

// Where a second label starts on the same line: "User: a Password: b", "user: a | pass: b".
const INLINE_SPLIT =
  /\s*(?:\s\|\s|\s\/\s|;\s|\t)\s*|,?\s+(?=(?:[\p{L}\p{N}]+ ){0,2}(?:password|passwd|pass|pwd|pin|username|user|login|e-?mail|mail|url|api key|key|token|secret)\s*[:=])/iu;

/** Every "label: value" on a line; several when one line holds a whole login. */
function labelsOf(line: string): Found[] {
  // A two-column table read top to bottom: "| Password | x |".
  const kv = line.match(/^\s*\|\s*([^|]+?)\s*\|\s*((?:[^|\\]|\\.)+?)\s*\|\s*$/);
  if (kv) {
    const l = classifyLabel(kv[1]!);
    return l && plausible(l, kv[2]!) ? [{ ...l, raw: kv[2]! }] : [];
  }
  const whole = labelOf(line);
  const parts: string[] = [];
  let carry = "";
  // A split can fall inside a label ("Account | username: x"): words without a colon go on.
  for (const p of line.split(INLINE_SPLIT).filter((x) => x?.trim())) {
    if (/[:=]/.test(p)) {
      parts.push(carry ? `${carry} ${p}` : p);
      carry = "";
    } else carry = carry ? `${carry} ${p}` : p;
  }
  if (carry) parts.push(carry);
  if (parts.length > 1) {
    const each = parts.map(labelOf);
    // Only when every part is a label: otherwise the value itself had a " / " in it.
    if (each.every(Boolean) && each.length > 1) return each as Found[];
  }
  return whole ? [whole] : [];
}

/** A label on its own line ("Password", "**Username:**"): its value is on the next line. */
function loneLabel(line: string): Label | null {
  const m = line.match(
    /^\s*(?:[-*+]\s+)?(?:\*\*|__)?([^:=]{1,44}?)(?:\*\*|__)?\s*[:=]?\s*(?:\*\*|__)?\s*$/,
  );
  return m ? classifyLabel(m[1]!) : null;
}

/** Names that say nothing about which account it is. */
const GENERIC_NAMES = new Set(
  [
    "password",
    "passwords",
    "login",
    "logins",
    "credentials",
    "credential",
    "account",
    "accounts",
    "access",
    "details",
    "info",
    "keys",
    "secrets",
    "untitled",
  ].map(norm),
);

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

/**
 * The first name that says which account it is: the service written in the
 * label, what smart fill found, the heading above, the site, the page.
 * "Password" or "Credentials" alone is no name; the page title says more.
 */
function pickName(...candidates: (string | null | undefined)[]): string {
  const ok = candidates
    .map((c) => (c ?? "").replace(/[*_`#]/g, "").trim())
    .filter((c) => c && c.length <= 80);
  // All generic: the last one, the page title, still says where it came from.
  return ok.find((c) => !GENERIC_NAMES.has(norm(c))) ?? ok.at(-1) ?? "Imported";
}

export function detectCredentials(
  lines: string[],
  ctx: { nodeKey: string; title: string; nextId: () => string },
): Credential[] {
  const found: Credential[] = [];
  const used = new Set<number>();
  let heading = ctx.title;
  const nameFor = (fallback?: string) => pickName(fallback, heading, ctx.title);

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
      .map((h, k) => (classifyLabel(h)?.secret ? k : -1))
      .filter((k) => k >= 0);
    let j = i + 2;
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]!)) j++;
    if (secretCols.length) {
      for (let r = i + 2; r < j; r++) {
        const row = cells(lines[r]!);
        const raws = secretCols
          .map((k) => row[k] ?? "")
          .filter((v) => v && !PLACEHOLDER.test(unescapeMd(v).trim()));
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
  let group: (Found & { line: number })[] = [];
  let groupHeading = heading;
  const flush = () => {
    const secrets = group.filter((g) => g.secret);
    if (secrets.length) {
      const recovery = group.find((g) => g.label === "recoveryemail");
      const text = group
        .filter((g) => g !== recovery)
        .map((g) => `${g.canon}: ${unescapeMd(g.raw)}`)
        .join("\n");
      const fill = smartFill(text);
      const type = settle(fill.type, fill.values);
      if (recovery) fill.values.recovery_email = unescapeMd(recovery.raw);
      const host = normalizeHost(fill.values.url ?? "");
      const service = group.find((g) => g.service)?.service;
      found.push({
        id: ctx.nextId(),
        nodeKey: ctx.nodeKey,
        source: "text",
        type,
        name: pickName(service, fill.name, groupHeading, host, ctx.title),
        values: fitFields(type, fill.values, unescapeMd(secrets[0]!.raw)),
        spans: secrets.map((s) => ({ line: s.line, raw: s.raw })),
      });
      for (const g of group) used.add(g.line);
    }
    group = [];
  };
  const add = (l: Found, line: number) => {
    if (!group.length) groupHeading = heading;
    // A field seen again ("Username:", or "user:", for a second account), or
    // another service ("Gmail user" after "Facebook password"), starts a new credential.
    const service = group.find((g) => g.service)?.service;
    if (
      group.some((g) => fieldOf(g.label) === fieldOf(l.label)) ||
      (l.service && service && norm(l.service) !== norm(service))
    )
      flush();
    if (!group.length) groupHeading = heading;
    group.push({ ...l, line });
  };
  // The value under a lone label: one token, maybe as a list item or a quote.
  const loneValue = (s: string) => {
    if (/^\s*(#|\||```|~~~)/.test(s) || labelOf(s) || loneLabel(s)) return null;
    const v = s
      .trim()
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, "")
      .replace(/^(\*\*|__|`)+|(\*\*|__|`)+$/g, "");
    return v && !/\s/.test(v) && v.length <= 200 ? v : null;
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
    // Blank lines and a table's |---| line do not end a group.
    if (!line.trim() || /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    const ls = labelsOf(line);
    if (ls.length) {
      for (const l of ls) add(l, i);
      continue;
    }
    // "Password" on one line and the value alone on the next (blank lines allowed).
    const lone = loneLabel(line);
    if (lone) {
      let j = i + 1;
      while (j < lines.length && j <= i + 3 && !lines[j]!.trim()) j++;
      const raw = j < lines.length && !used.has(j) ? loneValue(lines[j]!) : null;
      if (raw) {
        if (plausible(lone, raw)) {
          add({ ...lone, raw }, j);
          i = j;
          continue;
        }
      }
    }
    flush();
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
  return columns.filter((c) => classifyLabel(c)?.secret);
}

export function detectRowCredential(
  row: Record<string, string>,
  columns: string[],
  ctx: { nodeKey: string; title: string; nextId: () => string },
): Credential | null {
  const secretCols = secretColumnsOf(columns).filter((c) => {
    const v = (row[c] ?? "").trim();
    return v && !PLACEHOLDER.test(v);
  });
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

/**
 * Two finds are the same credential when they hold the same secrets for the
 * same account at the same place (the type may differ: a row and a page can
 * read one login differently). Memory only: the key holds the secrets.
 */
export function dedupeKey(c: Credential): string {
  const v = c.values;
  const sensitive = new Set(
    (getItemType(c.type)?.fields ?? []).filter((f) => f.sensitive).map((f) => f.key),
  );
  const secrets = Object.entries(v)
    .filter(([k, x]) => sensitive.has(k) && x.trim())
    .map(([, x]) => x.trim())
    .sort();
  const who = (v.username || v.email || v.account || "").trim().toLowerCase();
  const where =
    normalizeHost(v.url ?? v.base_url ?? "") ?? (v.host || v.hostname || "").trim().toLowerCase();
  return JSON.stringify([where, who, secrets]);
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
