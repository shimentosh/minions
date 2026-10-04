/**
 * The vault item type registry. Adding a type is an entry here plus, if it
 * needs one, a custom view in the web app. There is no database enum.
 *
 * `sensitive: true` fields are encrypted on the client and the server refuses
 * them unless they arrive as ciphertext envelopes. Non-sensitive fields are
 * searchable metadata. The split is the security contract, so err towards
 * sensitive.
 */

export type FieldKind =
  | "text"
  | "url"
  | "email"
  | "username"
  | "password"
  | "secret"
  | "totp"
  | "multiline"
  | "number"
  | "date"
  | "select"
  | "boolean"
  | "card-number"
  | "cvv"
  | "month"
  | "year"
  | "code";

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  sensitive: boolean;
  required?: boolean;
  options?: readonly string[];
  placeholder?: string;
  /** Offer the password generator on this field. */
  generate?: boolean;
  /** Hidden until "More fields" in the editor. */
  advanced?: boolean;
}

export type ItemCategory = "login" | "secret" | "infrastructure" | "financial" | "other";

export interface ItemTypeDef {
  type: string;
  label: string;
  plural: string;
  category: ItemCategory;
  /** lucide icon name, resolved in the UI. */
  icon: string;
  fields: readonly FieldDef[];
  /** Field whose value identifies the item in lists (username, host, provider…). */
  subtitleField?: string;
  /** The field that counts as "the password" for health checks. */
  passwordField?: string;
  /** Allows arbitrary user-named fields (environment variable groups). */
  dynamicFields?: { sensitive: boolean; keyPattern: RegExp; hint: string };
  /** Never sent to AI, never auto-categorised by AI. */
  financial?: boolean;
}

export const ENVIRONMENTS = ["Development", "Staging", "Production"] as const;
const STATUS = ["Active", "Rotating", "Revoked", "Expired"] as const;

const notes: FieldDef = { key: "notes", label: "Notes", kind: "multiline", sensitive: true };
const environment: FieldDef = {
  key: "environment",
  label: "Environment",
  kind: "select",
  sensitive: false,
  options: ENVIRONMENTS,
};

export const ITEM_TYPES: readonly ItemTypeDef[] = [
  {
    type: "LOGIN",
    label: "Login",
    plural: "Logins",
    category: "login",
    icon: "globe",
    subtitleField: "username",
    passwordField: "password",
    fields: [
      { key: "url", label: "Website", kind: "url", sensitive: false, placeholder: "https://" },
      { key: "username", label: "Username", kind: "username", sensitive: false },
      { key: "email", label: "Email", kind: "email", sensitive: false },
      { key: "password", label: "Password", kind: "password", sensitive: true, generate: true },
      { key: "totp", label: "One-time code (TOTP)", kind: "totp", sensitive: true },
      {
        key: "recovery_email",
        label: "Recovery email",
        kind: "email",
        sensitive: false,
        advanced: true,
      },
      {
        key: "recovery_phone",
        label: "Recovery phone",
        kind: "text",
        sensitive: true,
        advanced: true,
      },
      { key: "backup_codes", label: "Backup codes", kind: "code", sensitive: true, advanced: true },
      notes,
    ],
  },
  {
    type: "API_KEY",
    label: "API key",
    plural: "API keys",
    category: "secret",
    icon: "key-round",
    subtitleField: "provider",
    passwordField: "api_key",
    fields: [
      { key: "provider", label: "Provider", kind: "text", sensitive: false, required: true },
      { key: "api_key", label: "API key", kind: "secret", sensitive: true, required: true },
      { key: "api_secret", label: "Secret", kind: "secret", sensitive: true },
      environment,
      { key: "status", label: "Status", kind: "select", sensitive: false, options: STATUS },
      { key: "base_url", label: "Base URL", kind: "url", sensitive: false, advanced: true },
      { key: "docs_url", label: "Documentation", kind: "url", sensitive: false, advanced: true },
      {
        key: "permissions",
        label: "Permissions / scopes",
        kind: "text",
        sensitive: false,
        advanced: true,
      },
      { key: "expires_at", label: "Expires", kind: "date", sensitive: false },
      {
        key: "last_rotated",
        label: "Last rotated",
        kind: "date",
        sensitive: false,
        advanced: true,
      },
      notes,
    ],
  },
  {
    type: "SECRET",
    label: "Secret",
    plural: "Secrets",
    category: "secret",
    icon: "lock-keyhole",
    subtitleField: "provider",
    passwordField: "secret",
    fields: [
      { key: "provider", label: "Provider / service", kind: "text", sensitive: false },
      { key: "secret", label: "Secret", kind: "secret", sensitive: true, required: true },
      environment,
      { key: "status", label: "Status", kind: "select", sensitive: false, options: STATUS },
      { key: "expires_at", label: "Expires", kind: "date", sensitive: false, advanced: true },
      {
        key: "last_rotated",
        label: "Last rotated",
        kind: "date",
        sensitive: false,
        advanced: true,
      },
      notes,
    ],
  },
  {
    type: "ENVIRONMENT",
    label: "Environment variables",
    plural: "Environment variables",
    category: "secret",
    icon: "file-code",
    subtitleField: "environment",
    fields: [environment, notes],
    dynamicFields: {
      sensitive: true,
      keyPattern: /^[A-Za-z_][A-Za-z0-9_.]*$/,
      hint: "Paste a .env file or add KEY=value pairs",
    },
  },
  {
    type: "WEBHOOK",
    label: "Webhook secret",
    plural: "Webhook secrets",
    category: "secret",
    icon: "webhook",
    subtitleField: "provider",
    passwordField: "secret",
    fields: [
      {
        key: "provider",
        label: "Provider",
        kind: "text",
        sensitive: false,
        placeholder: "Stripe, GitHub, custom…",
      },
      { key: "endpoint", label: "Endpoint", kind: "url", sensitive: false },
      { key: "secret", label: "Signing secret", kind: "secret", sensitive: true, required: true },
      { key: "events", label: "Events", kind: "text", sensitive: false, advanced: true },
      environment,
      notes,
    ],
  },
  {
    type: "TOTP",
    label: "Authenticator (TOTP)",
    plural: "Authenticators",
    category: "secret",
    icon: "timer",
    subtitleField: "account",
    fields: [
      { key: "issuer", label: "Issuer", kind: "text", sensitive: false },
      { key: "account", label: "Account", kind: "text", sensitive: false },
      {
        key: "totp",
        label: "Secret or otpauth:// URI",
        kind: "totp",
        sensitive: true,
        required: true,
      },
      notes,
    ],
  },
  {
    type: "RECOVERY_CODE",
    label: "Recovery codes",
    plural: "Recovery codes",
    category: "secret",
    icon: "life-buoy",
    subtitleField: "account",
    fields: [
      { key: "service", label: "Service", kind: "text", sensitive: false },
      { key: "account", label: "Account", kind: "text", sensitive: false },
      { key: "codes", label: "Codes", kind: "code", sensitive: true, required: true },
      notes,
    ],
  },
  {
    type: "SERVER",
    label: "Server",
    plural: "Servers",
    category: "infrastructure",
    icon: "server",
    subtitleField: "host",
    passwordField: "password",
    fields: [
      { key: "host", label: "Host", kind: "text", sensitive: false, required: true },
      { key: "port", label: "Port", kind: "number", sensitive: false, placeholder: "22" },
      { key: "username", label: "Username", kind: "username", sensitive: false },
      { key: "password", label: "Password", kind: "password", sensitive: true, generate: true },
      { key: "private_key", label: "SSH private key", kind: "code", sensitive: true },
      {
        key: "public_key",
        label: "SSH public key",
        kind: "code",
        sensitive: false,
        advanced: true,
      },
      { key: "provider", label: "Provider", kind: "text", sensitive: false },
      environment,
      notes,
    ],
  },
  {
    type: "SSH_KEY",
    label: "SSH key",
    plural: "SSH keys",
    category: "infrastructure",
    icon: "terminal",
    subtitleField: "fingerprint",
    fields: [
      { key: "private_key", label: "Private key", kind: "code", sensitive: true, required: true },
      { key: "passphrase", label: "Passphrase", kind: "password", sensitive: true },
      { key: "public_key", label: "Public key", kind: "code", sensitive: false },
      { key: "fingerprint", label: "Fingerprint", kind: "text", sensitive: false, advanced: true },
      {
        key: "key_type",
        label: "Key type",
        kind: "select",
        sensitive: false,
        options: ["ed25519", "rsa", "ecdsa"],
        advanced: true,
      },
      notes,
    ],
  },
  {
    type: "DATABASE",
    label: "Database",
    plural: "Databases",
    category: "infrastructure",
    icon: "database",
    subtitleField: "host",
    passwordField: "password",
    fields: [
      {
        key: "engine",
        label: "Engine",
        kind: "select",
        sensitive: false,
        options: [
          "PostgreSQL",
          "MySQL",
          "MariaDB",
          "MongoDB",
          "Redis",
          "SQL Server",
          "SQLite",
          "Other",
        ],
      },
      { key: "host", label: "Host", kind: "text", sensitive: false },
      { key: "port", label: "Port", kind: "number", sensitive: false },
      { key: "database", label: "Database", kind: "text", sensitive: false },
      { key: "username", label: "Username", kind: "username", sensitive: false },
      { key: "password", label: "Password", kind: "password", sensitive: true, generate: true },
      // Connection strings almost always embed the password.
      { key: "connection_string", label: "Connection string", kind: "secret", sensitive: true },
      { key: "ssl", label: "SSL required", kind: "boolean", sensitive: false, advanced: true },
      environment,
      notes,
    ],
  },
  {
    type: "CLOUD",
    label: "Cloud credential",
    plural: "Cloud credentials",
    category: "infrastructure",
    icon: "cloud",
    subtitleField: "provider",
    passwordField: "secret_key",
    fields: [
      {
        key: "provider",
        label: "Provider",
        kind: "text",
        sensitive: false,
        required: true,
        placeholder: "Cloudflare, AWS, GCP…",
      },
      { key: "account_id", label: "Account / project ID", kind: "text", sensitive: false },
      { key: "access_key", label: "Access key ID / client ID", kind: "secret", sensitive: true },
      { key: "secret_key", label: "Secret / token", kind: "secret", sensitive: true },
      { key: "region", label: "Region", kind: "text", sensitive: false, advanced: true },
      { key: "console_url", label: "Console URL", kind: "url", sensitive: false, advanced: true },
      {
        key: "username",
        label: "Console username",
        kind: "username",
        sensitive: false,
        advanced: true,
      },
      {
        key: "password",
        label: "Console password",
        kind: "password",
        sensitive: true,
        advanced: true,
      },
      environment,
      { key: "expires_at", label: "Expires", kind: "date", sensitive: false, advanced: true },
      notes,
    ],
  },
  {
    type: "DOMAIN",
    label: "Domain",
    plural: "Domains",
    category: "infrastructure",
    icon: "at-sign",
    subtitleField: "domain",
    passwordField: "password",
    fields: [
      { key: "domain", label: "Domain", kind: "text", sensitive: false, required: true },
      { key: "registrar", label: "Registrar", kind: "text", sensitive: false },
      { key: "url", label: "Registrar login URL", kind: "url", sensitive: false },
      { key: "username", label: "Username", kind: "username", sensitive: false },
      { key: "password", label: "Password", kind: "password", sensitive: true, generate: true },
      { key: "expires_at", label: "Renews / expires", kind: "date", sensitive: false },
      { key: "nameservers", label: "Nameservers", kind: "text", sensitive: false, advanced: true },
      notes,
    ],
  },
  {
    type: "CREDIT_CARD",
    label: "Credit card",
    plural: "Credit cards",
    category: "financial",
    icon: "credit-card",
    financial: true,
    fields: [
      { key: "cardholder", label: "Cardholder", kind: "text", sensitive: true },
      { key: "number", label: "Card number", kind: "card-number", sensitive: true, required: true },
      { key: "exp_month", label: "Expiry month", kind: "month", sensitive: true },
      { key: "exp_year", label: "Expiry year", kind: "year", sensitive: true },
      { key: "cvv", label: "Security code", kind: "cvv", sensitive: true },
      { key: "pin", label: "PIN", kind: "password", sensitive: true, advanced: true },
      { key: "issuer", label: "Issuer", kind: "text", sensitive: false },
      {
        key: "billing_address",
        label: "Billing address",
        kind: "multiline",
        sensitive: true,
        advanced: true,
      },
      notes,
    ],
  },
  {
    type: "BANK_ACCOUNT",
    label: "Bank account",
    plural: "Bank accounts",
    category: "financial",
    icon: "landmark",
    financial: true,
    passwordField: "password",
    fields: [
      { key: "bank", label: "Bank", kind: "text", sensitive: false, required: true },
      { key: "account_name", label: "Account name", kind: "text", sensitive: true },
      { key: "account_number", label: "Account number", kind: "secret", sensitive: true },
      {
        key: "account_type",
        label: "Account type",
        kind: "select",
        sensitive: false,
        options: ["Checking", "Savings", "Business", "Credit", "Other"],
      },
      {
        key: "routing",
        label: "Routing / sort code / SWIFT",
        kind: "secret",
        sensitive: true,
        advanced: true,
      },
      { key: "iban", label: "IBAN", kind: "secret", sensitive: true, advanced: true },
      { key: "branch", label: "Branch", kind: "text", sensitive: false, advanced: true },
      { key: "url", label: "Online banking URL", kind: "url", sensitive: false },
      { key: "username", label: "Online banking username", kind: "username", sensitive: true },
      { key: "password", label: "Online banking password", kind: "password", sensitive: true },
      notes,
    ],
  },
  {
    type: "PAYMENT_ACCOUNT",
    label: "Payment account",
    plural: "Payment accounts",
    category: "financial",
    icon: "wallet",
    financial: true,
    subtitleField: "provider",
    passwordField: "password",
    fields: [
      {
        key: "provider",
        label: "Provider",
        kind: "text",
        sensitive: false,
        required: true,
        placeholder: "Stripe, PayPal, Wise…",
      },
      { key: "account_id", label: "Account ID", kind: "text", sensitive: false },
      { key: "url", label: "Dashboard URL", kind: "url", sensitive: false },
      { key: "username", label: "Login", kind: "username", sensitive: false },
      { key: "password", label: "Password", kind: "password", sensitive: true, generate: true },
      { key: "api_key", label: "API key", kind: "secret", sensitive: true, advanced: true },
      {
        key: "webhook_secret",
        label: "Webhook secret",
        kind: "secret",
        sensitive: true,
        advanced: true,
      },
      environment,
      notes,
    ],
  },
  {
    type: "LICENSE",
    label: "License key",
    plural: "License keys",
    category: "other",
    icon: "badge-check",
    subtitleField: "software",
    fields: [
      { key: "software", label: "Software", kind: "text", sensitive: false, required: true },
      { key: "license_key", label: "License key", kind: "secret", sensitive: true, required: true },
      { key: "licensed_to", label: "Licensed to", kind: "text", sensitive: false },
      { key: "email", label: "Account email", kind: "email", sensitive: false },
      { key: "purchase_date", label: "Purchased", kind: "date", sensitive: false },
      { key: "expires_at", label: "Expires", kind: "date", sensitive: false },
      notes,
    ],
  },
  {
    type: "SECURE_NOTE",
    label: "Secure note",
    plural: "Secure notes",
    category: "other",
    icon: "notebook-pen",
    fields: [
      { key: "content", label: "Content", kind: "multiline", sensitive: true, required: true },
    ],
  },
];

const byType = new Map(ITEM_TYPES.map((t) => [t.type, t]));

export function getItemType(type: string): ItemTypeDef | undefined {
  return byType.get(type);
}

export function isItemType(type: string): boolean {
  return byType.has(type);
}

export const CATEGORY_LABELS: Record<ItemCategory, string> = {
  login: "Logins",
  secret: "Secrets & keys",
  infrastructure: "Infrastructure",
  financial: "Financial",
  other: "Other",
};

export function typesInCategory(category: ItemCategory): string[] {
  return ITEM_TYPES.filter((t) => t.category === category).map((t) => t.type);
}

export const CUSTOM_FIELD_PREFIX = "custom.";
export const DYNAMIC_FIELD_PREFIX = "var.";

export interface ResolvedField {
  def: FieldDef;
  custom: boolean;
}

/**
 * Resolves a stored field key to its definition. Custom fields (any type) and
 * dynamic fields (types that allow them) carry their own label and
 * sensitivity; everything else must be in the registry.
 */
export function resolveField(
  type: string,
  key: string,
  custom?: { label: string; sensitive: boolean; kind?: FieldKind },
): ResolvedField | null {
  const def = byType.get(type);
  if (!def) return null;
  const known = def.fields.find((f) => f.key === key);
  if (known) return { def: known, custom: false };
  if (key.startsWith(CUSTOM_FIELD_PREFIX) && custom) {
    return {
      def: { key, label: custom.label, kind: custom.kind ?? "text", sensitive: custom.sensitive },
      custom: true,
    };
  }
  if (def.dynamicFields && key.startsWith(DYNAMIC_FIELD_PREFIX)) {
    const name = key.slice(DYNAMIC_FIELD_PREFIX.length);
    if (!def.dynamicFields.keyPattern.test(name)) return null;
    return {
      def: { key, label: name, kind: "secret", sensitive: def.dynamicFields.sensitive },
      custom: true,
    };
  }
  return null;
}
