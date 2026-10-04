/**
 * Recognising secrets in free text. Used in two directions:
 *  - Quick Capture pulls a secret out of what the user typed so it can be
 *    encrypted, and so the remaining text is safe to classify.
 *  - `sanitizeForAi` redacts anything secret-shaped before a payload leaves
 *    for DeepSeek. The server runs it again on whatever it receives.
 */

export interface SecretPattern {
  id: string;
  provider?: string;
  kind:
    | "api_key"
    | "token"
    | "private_key"
    | "card"
    | "iban"
    | "jwt"
    | "connection_string"
    | "totp_uri"
    | "password";
  regex: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: "pem",
    kind: "private_key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: "openai",
    provider: "OpenAI",
    kind: "api_key",
    regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "anthropic",
    provider: "Anthropic",
    kind: "api_key",
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "stripe",
    provider: "Stripe",
    kind: "api_key",
    regex: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  { id: "stripe-webhook", provider: "Stripe", kind: "token", regex: /\bwhsec_[A-Za-z0-9]{24,}\b/g },
  {
    id: "github",
    provider: "GitHub",
    kind: "token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  },
  { id: "gitlab", provider: "GitLab", kind: "token", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: "aws-akid", provider: "AWS", kind: "api_key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: "google", provider: "Google", kind: "api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack", provider: "Slack", kind: "token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  {
    id: "sendgrid",
    provider: "SendGrid",
    kind: "api_key",
    regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  },
  { id: "huggingface", provider: "Hugging Face", kind: "token", regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { id: "deepseek", provider: "DeepSeek", kind: "api_key", regex: /\bsk-[a-f0-9]{32}\b/g },
  { id: "npm", provider: "npm", kind: "token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    id: "jwt",
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "conn",
    kind: "connection_string",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s]+/gi,
  },
  { id: "otpauth", kind: "totp_uri", regex: /otpauth:\/\/[^\s]+/gi },
  {
    id: "iban",
    kind: "iban",
    regex: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g,
  },
];

export function luhnValid(digits: string): boolean {
  const clean = digits.replace(/\D/g, "");
  if (clean.length < 12 || clean.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function cardBrand(number: string): string | null {
  const n = number.replace(/\D/g, "");
  if (/^4/.test(n)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(n)) return "Mastercard";
  if (/^3[47]/.test(n)) return "Amex";
  if (/^6(011|5)/.test(n)) return "Discover";
  if (/^35(2[89]|[3-8])/.test(n)) return "JCB";
  if (/^3(0[0-5]|[68])/.test(n)) return "Diners";
  if (/^(62|81)/.test(n)) return "UnionPay";
  return null;
}

export function maskCard(last4: string | null | undefined): string {
  return `•••• •••• •••• ${last4 ?? "••••"}`;
}

const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A token that looks machine-generated: long, mixed, high entropy. */
export function looksLikeSecretToken(token: string): boolean {
  if (token.length < 16) return false;
  if (/^https?:\/\//i.test(token)) return false;
  if (/^[a-z]+$/i.test(token)) return false;
  const classes =
    Number(/[a-z]/.test(token)) +
    Number(/[A-Z]/.test(token)) +
    Number(/\d/.test(token)) +
    Number(/[^A-Za-z0-9]/.test(token));
  if (classes < 2) return false;
  return shannonEntropy(token) >= 3.3;
}

export interface SecretMatch {
  value: string;
  kind: SecretPattern["kind"] | "high_entropy";
  provider?: string;
  start: number;
  end: number;
}

// "password: hunter2", "pw = x", "pass is x", "cvv: 123", "pin 1234"
const ASSIGNMENT =
  /\b(password|passwd|pass|pwd|pw|pin|cvv|cvc|secret|token|api[ _-]?key|passphrase)\b(\s*(?:is|=|:|->)\s*|\s+)([^\s,;]+)/gi;
const STOPWORDS = new Set([
  "for",
  "to",
  "of",
  "the",
  "and",
  "is",
  "my",
  "a",
  "an",
  "in",
  "on",
  "at",
  "from",
  "with",
  "manager",
  "reset",
  "change",
  "changed",
]);

/** Without an explicit `:`/`=`, only treat the next word as a value if it looks like one. */
function plausibleValue(value: string, explicit: boolean): boolean {
  if (STOPWORDS.has(value.toLowerCase())) return false;
  // Our own redaction markers, when re-scanning already sanitised text.
  if (/^\[(REDACTED|NUMBER)\]/.test(value)) return false;
  if (explicit) return true;
  return /\d/.test(value) || /[^A-Za-z0-9]/.test(value) || looksLikeSecretToken(value);
}

export function findSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const taken = (start: number, end: number) => matches.some((m) => start < m.end && end > m.start);
  const push = (m: SecretMatch) => {
    if (!taken(m.start, m.end)) matches.push(m);
  };

  for (const pattern of SECRET_PATTERNS) {
    for (const m of text.matchAll(pattern.regex)) {
      if (pattern.kind === "iban" && !/\d{6,}/.test(m[0].replace(/\s/g, ""))) continue;
      push({
        value: m[0],
        kind: pattern.kind,
        provider: pattern.provider,
        start: m.index!,
        end: m.index! + m[0].length,
      });
    }
  }
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    if (luhnValid(m[0]))
      push({ value: m[0], kind: "card", start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(ASSIGNMENT)) {
    const value = m[3]!;
    if (!plausibleValue(value, m[2]!.trim() !== "")) continue;
    const start = m.index! + m[0].length - value.length;
    push({ value, kind: "password", start, end: start + value.length });
  }
  for (const m of text.matchAll(/[^\s"'`<>()]{16,}/g)) {
    if (looksLikeSecretToken(m[0]))
      push({ value: m[0], kind: "high_entropy", start: m.index!, end: m.index! + m[0].length });
  }
  return matches.sort((a, b) => a.start - b.start);
}

export function redactSecrets(text: string, replacement = "[REDACTED]"): string {
  const found = findSecrets(text);
  let out = "";
  let cursor = 0;
  for (const m of found) {
    out += text.slice(cursor, m.start) + replacement;
    cursor = m.end;
  }
  return out + text.slice(cursor);
}

/** Long runs of digits (account numbers, phone numbers, CVVs) never go out. */
function redactDigits(text: string): string {
  return text.replace(/\d[\d -]{5,}\d/g, "[NUMBER]");
}

const AI_STRING_LIMIT = 200;

/**
 * The last gate before anything goes to an AI provider. Accepts only plain
 * strings and string arrays, redacts secrets and long digit runs, and caps
 * length. Unknown shapes are dropped rather than passed through.
 */
export function sanitizeForAi<T extends Record<string, unknown>>(
  payload: T,
): Record<string, string | string[]> {
  const clean = (value: string) =>
    redactDigits(redactSecrets(value)).replace(/\s+/g, " ").trim().slice(0, AI_STRING_LIMIT);
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") {
      const v = clean(value);
      if (v) out[key] = v;
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out[key] = (value as string[]).slice(0, 20).map(clean).filter(Boolean);
    }
  }
  return out;
}
