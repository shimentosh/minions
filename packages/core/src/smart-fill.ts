import { parseCardText } from "./card-parse";
import { analyzeCapture } from "./classify";
import { findSecrets, luhnValid } from "./detect";
import { parseDotenv } from "./env";
import { DYNAMIC_FIELD_PREFIX, getItemType } from "./item-types";
import { findProviderByHost, findProviderByName } from "./providers";
import { isValidTotp } from "./totp";
import { normalizeHost } from "./url";

/**
 * "Paste anything": turns whatever the user pasted (a site, an email, a
 * password, `key: value` lines, a `.env` block, a card) into field values for
 * one item type. Runs on the device only.
 */

export interface SmartFillResult {
  type: string;
  values: Record<string, string>;
  name?: string;
  /** Field keys that were filled, in order, for the "Filled: …" summary. */
  filled: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Label someone might type → candidate field keys, first existing one wins.
const ALIASES: [string[], string[]][] = [
  [["name", "title", "account name"], ["__name"]],
  [
    ["url", "website", "site", "link", "web", "login url", "address"],
    ["url", "base_url", "console_url", "endpoint", "domain"],
  ],
  [
    ["user", "username", "login", "user name", "userid", "user id", "id"],
    ["username", "account", "licensed_to"],
  ],
  [
    ["email", "mail", "e mail", "email address"],
    ["email", "username", "account"],
  ],
  [
    ["pass", "password", "pwd", "pw", "passcode"],
    ["password", "passphrase"],
  ],
  [["2fa", "totp", "otp", "authenticator", "2fa secret", "mfa"], ["totp"]],
  [
    ["backup codes", "recovery codes", "codes"],
    ["backup_codes", "codes"],
  ],
  [
    ["host", "server", "ip", "hostname"],
    ["host", "domain"],
  ],
  [["port"], ["port"]],
  [["database", "db", "db name"], ["database"]],
  [["connection string", "connection", "dsn", "database url"], ["connection_string"]],
  [
    ["key", "api key", "apikey", "token", "access token", "api token"],
    ["api_key", "secret_key", "secret", "license_key"],
  ],
  [
    ["secret", "api secret", "client secret", "secret key"],
    ["api_secret", "secret", "secret_key"],
  ],
  [["access key", "access key id", "client id"], ["access_key"]],
  [
    ["provider", "service", "issuer"],
    ["provider", "issuer", "service"],
  ],
  [["environment", "env"], ["environment"]],
  [
    ["card", "card number", "number", "cc"],
    ["number", "account_number"],
  ],
  [["cvv", "cvc", "security code"], ["cvv"]],
  [["name on card", "cardholder", "holder"], ["cardholder"]],
  [
    ["expiry", "exp", "expires", "expiration", "valid thru"],
    ["__expiry", "expires_at"],
  ],
  [["pin"], ["pin"]],
  [["iban"], ["iban"]],
  [["account number", "acc no", "account no"], ["account_number"]],
  [["bank"], ["bank"]],
  [["license", "license key", "serial"], ["license_key"]],
  [["private key", "ssh key"], ["private_key"]],
  [["public key"], ["public_key"]],
  [["region"], ["region"]],
  [["account id", "project id"], ["account_id"]],
  [
    ["note", "notes", "comment"],
    ["notes", "content"],
  ],
];

const LABEL_LINE = /^\s*([A-Za-z][A-Za-z0-9 ._/-]{0,30}?)\s*[:=]\s*(.+?)\s*$/;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function smartFill(text: string, typeHint?: string): SmartFillResult {
  const capture = analyzeCapture(text);
  let type = typeHint && getItemType(typeHint) ? typeHint : capture.classification.type;
  // An email plus a password is a login, even at a registrar or a payment
  // company, unless the paste is clearly something else (a card, a key…).
  const specific = [
    "CREDIT_CARD",
    "BANK_ACCOUNT",
    "SSH_KEY",
    "DATABASE",
    "TOTP",
    "ENVIRONMENT",
    "API_KEY",
    "WEBHOOK",
    "SERVER",
  ];
  // A password (or an email) next to a 2FA secret is a login that has 2FA,
  // not an authenticator entry.
  const hasPasswordLabel = /^\s*(?:pass|password|pwd|pw)\s*[:=]/im.test(text);
  if (
    !typeHint &&
    (capture.email || hasPasswordLabel) &&
    (!specific.includes(type) || type === "TOTP")
  )
    type = "LOGIN";
  const card = parseCardText(text);
  if (!typeHint && card.number && !capture.email) type = "CREDIT_CARD";
  const def = getItemType(type)!;
  const has = (k: string) => def.fields.some((f) => f.key === k);
  const values: Record<string, string> = {};
  const filled: string[] = [];
  let name: string | undefined;

  const put = (candidates: string[], value: string): boolean => {
    const v = value.trim();
    if (!v) return false;
    for (const key of candidates) {
      if (key === "__name") {
        name ??= v;
        return true;
      }
      if (key === "__expiry") {
        const m = v.match(/^(\d{1,2})\s*[/-]\s*(\d{2,4})$/);
        if (m && has("exp_month")) {
          put(["exp_month"], m[1]!.padStart(2, "0"));
          put(["exp_year"], m[2]!.length === 2 ? `20${m[2]}` : m[2]!);
          return true;
        }
        continue;
      }
      if (has(key) && !values[key]) {
        values[key] = key === "url" && !/^[a-z]+:\/\//i.test(v) ? `https://${v}` : v;
        filled.push(key);
        return true;
      }
    }
    return false;
  };

  // Cards: number by Luhn, then expiry, CVV and the name around it.
  if (type === "CREDIT_CARD") {
    const add = (k: string, v: string | undefined) => {
      if (v) {
        values[k] = v;
        filled.push(k);
      }
    };
    add("number", card.number);
    add("exp_month", card.expMonth);
    add("exp_year", card.expYear);
    add("cvv", card.cvv);
    add("cardholder", card.cardholder);
    const issuer = text.match(/^\s*(?:issuer|bank)\s*[:=]\s*(.+?)\s*$/im)?.[1];
    add("issuer", issuer);
    const pin = text.match(/\bpin\b\D{0,3}(\d{4,6})\b/i)?.[1];
    add("pin", pin);
    return {
      type,
      values,
      filled,
      name: card.number ? `${card.brand ?? "Card"} •••• ${card.number.slice(-4)}` : undefined,
    };
  }

  // Environment variables: every KEY=value line is a variable.
  if (def.dynamicFields) {
    for (const { key, value } of parseDotenv(text)) {
      values[`${DYNAMIC_FIELD_PREFIX}${key}`] = value;
      filled.push(`${DYNAMIC_FIELD_PREFIX}${key}`);
    }
    if (filled.length) return { type, values, filled };
  }

  // Multi-line secrets first, before anything splits them.
  let rest = text;
  for (const s of findSecrets(text)) {
    if (s.kind === "private_key") {
      if (put(["private_key"], s.value)) rest = rest.replace(s.value, " ");
    }
  }

  const unlabelled: string[] = [];
  for (const line of rest.split(/\r?\n/)) {
    const m = line.match(LABEL_LINE);
    // "https://x" and "me@x.com:pass" look labelled but are not.
    if (
      m &&
      !/^(https?|otpauth|postgres(ql)?|mysql|mongodb(\+srv)?|redis)$/i.test(m[1]!.trim()) &&
      !m[1]!.includes("@")
    ) {
      const label = norm(m[1]!);
      const hit = ALIASES.find(([labels]) => labels.some((l) => norm(l) === label));
      const ownField = def.fields.find((f) => norm(f.label) === label || norm(f.key) === label);
      if (ownField && put([ownField.key], m[2]!)) continue;
      // "User: me@x.com" belongs in Email when the type has one.
      if (hit?.[1].includes("username") && EMAIL.test(m[2]!.trim()) && put(["email"], m[2]!))
        continue;
      if (hit && put(hit[1], m[2]!)) continue;
    }
    unlabelled.push(line);
  }

  // Tokens with no label: recognise them by shape.
  const tokens = unlabelled
    .join(" ")
    .split(/[\s|,;]+/)
    .flatMap((t) => {
      // "me@gmail.com:hunter2" (common export format)
      const m = t.match(/^([^\s:]+@[^\s:]+\.[a-z]{2,}):(.+)$/i);
      return m ? [m[1]!, m[2]!] : [t];
    })
    .filter(Boolean);
  const cardDigits = unlabelled.join(" ").match(/\b(?:\d[ -]?){12,18}\d\b/)?.[0];
  if (cardDigits && luhnValid(cardDigits)) put(["number"], cardDigits.replace(/\D/g, ""));

  const leftovers: string[] = [];
  for (const t of tokens) {
    if (cardDigits?.includes(t)) continue;
    if (
      /^otpauth:\/\//i.test(t) ||
      (has("totp") && /^[A-Z2-7]{16,}=*$/.test(t) && isValidTotp(t))
    ) {
      if (put(["totp"], t)) continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i.test(t) && put(["connection_string"], t))
      continue;
    if (EMAIL.test(t) && put(["email", "username", "account"], t)) continue;
    if (
      !t.includes("@") &&
      /\./.test(t) &&
      normalizeHost(t) &&
      !/^\d+(\.\d+)*$/.test(t.replace(/:\d+$/, ""))
    ) {
      if (put(["url", "base_url", "console_url", "endpoint", "domain", "host"], t)) continue;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(t)) {
      const [ip, port] = t.split(":");
      if (put(["host"], ip!)) {
        if (port) put(["port"], port);
        continue;
      }
    }
    leftovers.push(t);
  }

  // What's left: known secret shapes go to the key field, then a username
  // (looks like a word) and a password (anything else).
  const secretField =
    def.passwordField && def.passwordField !== "password"
      ? [def.passwordField]
      : ["api_key", "secret_key", "secret", "license_key"];
  const isWord = (t: string) => /^[A-Za-z0-9._-]{2,40}$/.test(t) && !/\d.*[A-Z]|[A-Z].*\d/.test(t);
  const plainWords: string[] = [];
  for (const t of leftovers) {
    if (
      findProviderByName(t) &&
      put(["provider", "issuer", "service", "registrar", "bank"], findProviderByName(t)!.name)
    )
      continue;
    const kind = findSecrets(t)[0]?.kind;
    if ((kind === "api_key" || kind === "token" || kind === "jwt") && put(secretField, t)) continue;
    if (isWord(t)) {
      if (!values.username && !values.email && has("username") && put(["username"], t)) continue;
      plainWords.push(t);
      continue;
    }
    put(["password", ...secretField], t);
  }
  // A plain word is a secret only if nothing more secret-looking was pasted.
  for (const t of plainWords) if (!put(["password", ...secretField], t)) break;

  const host = normalizeHost(
    values.url ?? values.base_url ?? values.console_url ?? values.endpoint ?? values.domain ?? null,
  );
  if (!name && host) {
    const provider = findProviderByHost(host);
    const label = host.split(".").slice(-2, -1)[0] ?? host;
    name = provider?.name ?? label.charAt(0).toUpperCase() + label.slice(1);
  }
  if (!name && capture.classification.provider) name = capture.classification.provider;
  if (capture.classification.provider)
    put(["provider", "issuer", "service"], capture.classification.provider);
  return { type, values, name, filled };
}
