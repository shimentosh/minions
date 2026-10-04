/**
 * Known services, for recognising what an item is about from safe metadata
 * (a name, a host, a sentence typed into Quick Capture). A hint, never a
 * limit: any provider name works everywhere.
 */

export interface ProviderDef {
  name: string;
  aliases?: string[];
  hosts: string[];
  /** Default type when the text gives no better clue. */
  type: string;
  collection: string;
  tags: string[];
}

export const PROVIDERS: readonly ProviderDef[] = [
  {
    name: "Google",
    aliases: ["gmail", "google account"],
    hosts: ["google.com", "accounts.google.com", "gmail.com"],
    type: "LOGIN",
    collection: "Personal",
    tags: ["personal"],
  },
  {
    name: "YouTube",
    hosts: ["youtube.com"],
    type: "LOGIN",
    collection: "Social",
    tags: ["social"],
  },
  {
    name: "GitHub",
    hosts: ["github.com"],
    type: "LOGIN",
    collection: "Development",
    tags: ["development"],
  },
  {
    name: "GitLab",
    hosts: ["gitlab.com"],
    type: "LOGIN",
    collection: "Development",
    tags: ["development"],
  },
  {
    name: "Cloudflare",
    hosts: ["cloudflare.com", "dash.cloudflare.com"],
    type: "CLOUD",
    collection: "Infrastructure",
    tags: ["infrastructure"],
  },
  {
    name: "AWS",
    aliases: ["amazon web services"],
    hosts: ["aws.amazon.com", "console.aws.amazon.com"],
    type: "CLOUD",
    collection: "Infrastructure",
    tags: ["infrastructure", "cloud"],
  },
  {
    name: "Google Cloud",
    aliases: ["gcp"],
    hosts: ["cloud.google.com", "console.cloud.google.com"],
    type: "CLOUD",
    collection: "Infrastructure",
    tags: ["infrastructure", "cloud"],
  },
  {
    name: "Azure",
    hosts: ["portal.azure.com", "azure.com"],
    type: "CLOUD",
    collection: "Infrastructure",
    tags: ["infrastructure", "cloud"],
  },
  {
    name: "DigitalOcean",
    hosts: ["digitalocean.com", "cloud.digitalocean.com"],
    type: "CLOUD",
    collection: "Infrastructure",
    tags: ["infrastructure", "cloud"],
  },
  {
    name: "Hetzner",
    hosts: ["hetzner.com", "console.hetzner.cloud"],
    type: "SERVER",
    collection: "Infrastructure",
    tags: ["infrastructure", "server"],
  },
  {
    name: "Vercel",
    hosts: ["vercel.com"],
    type: "CLOUD",
    collection: "Infrastructure",
    tags: ["infrastructure"],
  },
  {
    name: "Netlify",
    hosts: ["netlify.com", "app.netlify.com"],
    type: "CLOUD",
    collection: "Infrastructure",
    tags: ["infrastructure"],
  },
  {
    name: "Supabase",
    hosts: ["supabase.com", "supabase.co"],
    type: "CLOUD",
    collection: "Infrastructure",
    tags: ["infrastructure", "database"],
  },
  {
    name: "OpenAI",
    hosts: ["openai.com", "platform.openai.com"],
    type: "API_KEY",
    collection: "Development",
    tags: ["api", "ai"],
  },
  {
    name: "Anthropic",
    aliases: ["claude"],
    hosts: ["anthropic.com", "console.anthropic.com"],
    type: "API_KEY",
    collection: "Development",
    tags: ["api", "ai"],
  },
  {
    name: "Gemini",
    aliases: ["google ai studio"],
    hosts: ["aistudio.google.com"],
    type: "API_KEY",
    collection: "Development",
    tags: ["api", "ai"],
  },
  {
    name: "DeepSeek",
    hosts: ["deepseek.com", "platform.deepseek.com"],
    type: "API_KEY",
    collection: "Development",
    tags: ["api", "ai"],
  },
  {
    name: "Kie.ai",
    aliases: ["kie"],
    hosts: ["kie.ai"],
    type: "API_KEY",
    collection: "Development",
    tags: ["api", "ai"],
  },
  {
    name: "Hugging Face",
    aliases: ["huggingface"],
    hosts: ["huggingface.co"],
    type: "API_KEY",
    collection: "Development",
    tags: ["api", "ai"],
  },
  {
    name: "Stripe",
    hosts: ["stripe.com", "dashboard.stripe.com"],
    type: "PAYMENT_ACCOUNT",
    collection: "Finance",
    tags: ["finance", "payments"],
  },
  {
    name: "PayPal",
    hosts: ["paypal.com"],
    type: "PAYMENT_ACCOUNT",
    collection: "Finance",
    tags: ["finance", "payments"],
  },
  {
    name: "Wise",
    hosts: ["wise.com"],
    type: "PAYMENT_ACCOUNT",
    collection: "Finance",
    tags: ["finance", "payments"],
  },
  {
    name: "Notion",
    hosts: ["notion.so", "notion.com"],
    type: "LOGIN",
    collection: "Business",
    tags: ["productivity"],
  },
  {
    name: "Slack",
    hosts: ["slack.com"],
    type: "LOGIN",
    collection: "Business",
    tags: ["business"],
  },
  {
    name: "Discord",
    hosts: ["discord.com"],
    type: "LOGIN",
    collection: "Social",
    tags: ["social"],
  },
  {
    name: "Facebook",
    aliases: ["meta"],
    hosts: ["facebook.com"],
    type: "LOGIN",
    collection: "Social",
    tags: ["social"],
  },
  {
    name: "Instagram",
    hosts: ["instagram.com"],
    type: "LOGIN",
    collection: "Social",
    tags: ["social"],
  },
  {
    name: "X",
    aliases: ["twitter"],
    hosts: ["x.com", "twitter.com"],
    type: "LOGIN",
    collection: "Social",
    tags: ["social"],
  },
  {
    name: "LinkedIn",
    hosts: ["linkedin.com"],
    type: "LOGIN",
    collection: "Social",
    tags: ["social", "business"],
  },
  {
    name: "Microsoft",
    aliases: ["outlook", "office 365"],
    hosts: ["microsoft.com", "live.com", "outlook.com"],
    type: "LOGIN",
    collection: "Personal",
    tags: ["personal"],
  },
  {
    name: "Apple",
    aliases: ["icloud", "apple id"],
    hosts: ["apple.com", "icloud.com"],
    type: "LOGIN",
    collection: "Personal",
    tags: ["personal"],
  },
  {
    name: "Amazon",
    hosts: ["amazon.com"],
    type: "LOGIN",
    collection: "Personal",
    tags: ["shopping"],
  },
  {
    name: "Namecheap",
    hosts: ["namecheap.com"],
    type: "DOMAIN",
    collection: "Domains",
    tags: ["domains"],
  },
  {
    name: "GoDaddy",
    hosts: ["godaddy.com"],
    type: "DOMAIN",
    collection: "Domains",
    tags: ["domains"],
  },
  {
    name: "Porkbun",
    hosts: ["porkbun.com"],
    type: "DOMAIN",
    collection: "Domains",
    tags: ["domains"],
  },
  {
    name: "Resend",
    hosts: ["resend.com"],
    type: "API_KEY",
    collection: "Development",
    tags: ["api", "email"],
  },
  {
    name: "SendGrid",
    hosts: ["sendgrid.com"],
    type: "API_KEY",
    collection: "Development",
    tags: ["api", "email"],
  },
  {
    name: "Twilio",
    hosts: ["twilio.com"],
    type: "API_KEY",
    collection: "Development",
    tags: ["api"],
  },
  {
    name: "Docker Hub",
    aliases: ["docker"],
    hosts: ["hub.docker.com", "docker.com"],
    type: "LOGIN",
    collection: "Development",
    tags: ["development"],
  },
  {
    name: "npm",
    hosts: ["npmjs.com"],
    type: "API_KEY",
    collection: "Development",
    tags: ["development"],
  },
  { name: "Figma", hosts: ["figma.com"], type: "LOGIN", collection: "Business", tags: ["design"] },
];

function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

export function findProviderByHost(host: string | null | undefined): ProviderDef | undefined {
  if (!host) return undefined;
  const h = host.toLowerCase();
  return PROVIDERS.find((p) => p.hosts.some((ph) => h === ph || h.endsWith(`.${ph}`)));
}

/** Longest provider name or alias that appears as a whole word in the text. */
export function findProviderInText(text: string): ProviderDef | undefined {
  const hay = ` ${norm(text)} `;
  let best: { p: ProviderDef; len: number } | undefined;
  for (const p of PROVIDERS) {
    for (const candidate of [p.name, ...(p.aliases ?? [])]) {
      const needle = norm(candidate);
      if (needle.length < 2) continue;
      if (hay.includes(` ${needle} `) && (!best || needle.length > best.len))
        best = { p, len: needle.length };
    }
  }
  return best?.p;
}

export function findProviderByName(name: string | null | undefined): ProviderDef | undefined {
  if (!name) return undefined;
  const n = norm(name);
  return PROVIDERS.find((p) => [p.name, ...(p.aliases ?? [])].some((c) => norm(c) === n));
}
