import { cardBrand, findSecrets, luhnValid, redactSecrets, type SecretMatch } from "./detect";
import { ENVIRONMENTS, getItemType } from "./item-types";
import {
  findProviderByHost,
  findProviderByName,
  findProviderInText,
  type ProviderDef,
} from "./providers";
import { normalizeHost } from "./url";

/**
 * Rule-based classification. Runs on the client (Quick Capture, imports,
 * the extension) and on the server (organising items from safe metadata).
 * AI is consulted only when this is unsure, and only with safe metadata.
 */

export interface Classification {
  type: string;
  provider?: string;
  project?: string;
  collection?: string;
  environment?: string;
  tags: string[];
  confidence: number;
  reasons: string[];
  source: "rules" | "preferences" | "ai";
}

export type ConfidenceBand = "high" | "medium" | "low";

export const CONFIDENCE = { high: 0.85, medium: 0.6 } as const;

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= CONFIDENCE.high) return "high";
  if (confidence >= CONFIDENCE.medium) return "medium";
  return "low";
}

/** A learned correction: "items matching `matchKey` go to `value`". */
export interface ClassificationPreference {
  matchKey: string;
  target: "project" | "collection" | "type" | "tag";
  value: string;
  weight: number;
}

/** Keys an item is matched on when learning or applying preferences. */
export function preferenceKeys(input: {
  provider?: string;
  host?: string | null;
  type?: string;
}): string[] {
  const keys: string[] = [];
  if (input.provider) keys.push(`provider:${input.provider.toLowerCase()}`);
  if (input.host) keys.push(`host:${input.host}`);
  if (input.type && input.provider)
    keys.push(`type-provider:${input.type}:${input.provider.toLowerCase()}`);
  return keys;
}

export interface ClassifyContext {
  projects?: string[];
  collections?: string[];
  preferences?: ClassificationPreference[];
}

const TYPE_KEYWORDS: [RegExp, string, number][] = [
  [/\b(credit|debit)\s*card\b|\bvisa\b|\bmastercard\b|\bamex\b/i, "CREDIT_CARD", 0.9],
  [
    /\bbank\s*(account)?\b|\biban\b|\bswift\b|\brouting number\b|\baccount number\b/i,
    "BANK_ACCOUNT",
    0.85,
  ],
  [/\bwebhook\b|\bwhsec_/i, "WEBHOOK", 0.9],
  [/\b(ssh|private)\s*key\b|\bid_(rsa|ed25519)\b/i, "SSH_KEY", 0.85],
  [/\b(vps|server|droplet|ec2 instance|dedicated)\b/i, "SERVER", 0.8],
  [/\b(database|postgres(ql)?|mysql|mariadb|mongo(db)?|redis)\b|\bdb\b/i, "DATABASE", 0.8],
  [/\b(\.env|env vars?|environment variables?)\b/i, "ENVIRONMENT", 0.85],
  [/\blicen[cs]e\s*(key)?\b|\bserial\b|\bactivation code\b/i, "LICENSE", 0.85],
  [/\b(recovery|backup)\s*codes?\b/i, "RECOVERY_CODE", 0.85],
  [/\b(2fa|totp|authenticator|otp)\b|otpauth:\/\//i, "TOTP", 0.8],
  [/\bapi[ _-]?(key|token)\b|\baccess token\b|\bbearer\b/i, "API_KEY", 0.85],
  [/\b(token|secret)\b/i, "SECRET", 0.65],
  [/\b(login|log in|sign in|account|password|username)\b/i, "LOGIN", 0.75],
  [/\bnote\b/i, "SECURE_NOTE", 0.5],
];

const SECRET_KIND_TYPE: Partial<Record<SecretMatch["kind"], [string, number]>> = {
  private_key: ["SSH_KEY", 0.9],
  card: ["CREDIT_CARD", 0.95],
  iban: ["BANK_ACCOUNT", 0.85],
  connection_string: ["DATABASE", 0.85],
  totp_uri: ["TOTP", 0.95],
  api_key: ["API_KEY", 0.9],
  token: ["API_KEY", 0.8],
  jwt: ["SECRET", 0.7],
};

function detectEnvironment(text: string): string | undefined {
  if (/\b(prod|production|live)\b/i.test(text)) return "Production";
  if (/\b(stag|staging|preprod|uat)\b/i.test(text)) return "Staging";
  if (/\b(dev|development|local|test|sandbox)\b/i.test(text)) return "Development";
  return undefined;
}

function findNamed(text: string, names: string[] | undefined): string | undefined {
  if (!names?.length) return undefined;
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9.]+/g, " ")} `;
  return [...names]
    .sort((a, b) => b.length - a.length)
    .find((n) => {
      const needle = n
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, " ")
        .trim();
      return needle.length > 1 && hay.includes(` ${needle} `);
    });
}

function applyPreferences(
  result: Classification,
  ctx: ClassifyContext,
  host: string | null,
): Classification {
  if (!ctx.preferences?.length) return result;
  const keys = new Set(preferenceKeys({ provider: result.provider, host, type: result.type }));
  const best = new Map<string, ClassificationPreference>();
  for (const pref of ctx.preferences) {
    if (!keys.has(pref.matchKey) || pref.weight < 2) continue;
    const current = best.get(pref.target);
    if (!current || pref.weight > current.weight) best.set(pref.target, pref);
  }
  if (best.size === 0) return result;
  const out = {
    ...result,
    tags: [...result.tags],
    reasons: [...result.reasons],
    source: "preferences" as const,
  };
  for (const [target, pref] of best) {
    if (target === "project") out.project = pref.value;
    if (target === "collection") out.collection = pref.value;
    if (target === "type" && getItemType(pref.value)) out.type = pref.value;
    if (target === "tag" && !out.tags.includes(pref.value)) out.tags.push(pref.value);
    out.reasons.push(`You usually file ${pref.matchKey.split(":").pop()} under ${pref.value}`);
  }
  out.confidence = Math.max(out.confidence, 0.9);
  return out;
}

export interface CaptureResult {
  classification: Classification;
  secrets: SecretMatch[];
  /** The input with every detected secret removed. Safe to show, log or classify. */
  safeText: string;
  url?: string;
  host?: string | null;
  email?: string;
  username?: string;
  card?: { brand: string | null; last4: string };
  /** A name for the item, from the provider and context. */
  suggestedName: string;
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const URL_RE = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i;

export function classify(
  input: { text?: string; name?: string; host?: string | null; provider?: string; type?: string },
  ctx: ClassifyContext = {},
): Classification {
  const text = [input.name, input.provider, input.text].filter(Boolean).join(" ");
  const reasons: string[] = [];
  let type = input.type;
  let confidence = type ? 0.95 : 0;

  const provider: ProviderDef | undefined =
    findProviderByName(input.provider) ??
    findProviderByHost(input.host) ??
    findProviderInText(text);
  if (provider) reasons.push(`Recognised ${provider.name}`);

  if (!type) {
    for (const [re, t, c] of TYPE_KEYWORDS) {
      if (re.test(text)) {
        type = t;
        confidence = c;
        reasons.push(`Mentions “${text.match(re)![0].trim()}”`);
        break;
      }
    }
  }
  // "Cloudflare token", "OpenAI secret": at a known service that is an API credential.
  if (type === "SECRET" && provider && provider.type !== "LOGIN") {
    type = "API_KEY";
    confidence = 0.8;
  }
  if (!type && provider) {
    type = provider.type;
    confidence = 0.7;
  }
  if (!type) {
    type = input.host ? "LOGIN" : "SECURE_NOTE";
    confidence = input.host ? 0.55 : 0.3;
  }
  // "Stripe API key" → API key, "Stripe account" → payment account.
  if (
    provider &&
    type === "LOGIN" &&
    provider.type !== "LOGIN" &&
    !/\b(login|password|sign in)\b/i.test(text)
  ) {
    type = provider.type;
  }

  const environment = detectEnvironment(text);
  const project = findNamed(text, ctx.projects);
  if (project) reasons.push(`Mentions project ${project}`);
  const collection = findNamed(text, ctx.collections) ?? provider?.collection;

  const tags = new Set(provider?.tags ?? []);
  if (environment) tags.add(environment.toLowerCase());
  const def = getItemType(type);
  if (def?.category === "financial") tags.add("finance");
  if (def?.category === "infrastructure") tags.add("infrastructure");

  const base: Classification = {
    type,
    provider: provider?.name ?? input.provider,
    project,
    collection,
    environment,
    tags: [...tags],
    // A keyword that agrees with what the provider is known for is strong evidence.
    confidence: Math.min(
      1,
      confidence + (provider ? (provider.type === type ? 0.1 : 0.05) : 0) + (project ? 0.03 : 0),
    ),
    reasons,
    source: "rules",
  };
  return applyPreferences(base, ctx, input.host ?? null);
}

/**
 * Quick Capture: "Cloudflare production token for ClipMesh cf_abc…" →
 * type, provider, project, environment, plus the secret pulled out for
 * encryption. Nothing here leaves the device.
 */
export function analyzeCapture(text: string, ctx: ClassifyContext = {}): CaptureResult {
  const secrets = findSecrets(text);
  const safeText = redactSecrets(text, "").replace(/\s+/g, " ").trim();

  const emailMatch = safeText.match(EMAIL)?.[0];
  const urlMatch = safeText.replace(EMAIL, "").match(URL_RE)?.[0];
  const host = normalizeHost(urlMatch);

  let classification = classify({ text: safeText, host }, ctx);
  const strongest = secrets
    .map((s) => ({ s, hint: SECRET_KIND_TYPE[s.kind] }))
    .filter((x) => x.hint)
    .sort((a, b) => b.hint![1] - a.hint![1])[0];
  if (strongest && strongest.hint![1] > classification.confidence) {
    classification = {
      ...classification,
      type: strongest.hint![0],
      provider: classification.provider ?? strongest.s.provider,
      confidence: strongest.hint![1],
      reasons: [
        ...classification.reasons,
        `Contains what looks like a ${strongest.s.kind.replace("_", " ")}`,
      ],
    };
  } else if (strongest?.s.provider && !classification.provider) {
    classification = { ...classification, provider: strongest.s.provider };
  }

  let card: CaptureResult["card"];
  const cardSecret = secrets.find((s) => s.kind === "card");
  if (cardSecret && luhnValid(cardSecret.value)) {
    const digits = cardSecret.value.replace(/\D/g, "");
    card = { brand: cardBrand(digits), last4: digits.slice(-4) };
  }

  const envLabel =
    classification.environment && classification.environment !== "Production"
      ? ` (${classification.environment})`
      : "";
  const def = getItemType(classification.type);
  const nameBase =
    classification.provider ??
    (host
      ? host
          .split(".")
          .slice(-2, -1)[0]!
          .replace(/^./, (c) => c.toUpperCase())
      : undefined) ??
    card?.brand ??
    def?.label ??
    "New item";
  const typeSuffix =
    classification.type === "LOGIN" || !classification.provider
      ? ""
      : ` ${def?.label ?? ""}`.replace(/ Login$/, "");
  const suggestedName =
    `${nameBase}${classification.provider && classification.type !== "LOGIN" && classification.type !== "PAYMENT_ACCOUNT" && classification.type !== "CLOUD" ? typeSuffix : ""}${envLabel}`.trim();

  return {
    classification,
    secrets,
    safeText,
    url: urlMatch,
    host,
    email: emailMatch,
    username: emailMatch,
    card,
    suggestedName,
  };
}

export { ENVIRONMENTS };
