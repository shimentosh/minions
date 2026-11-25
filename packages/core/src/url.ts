import { getDomain, parse } from "tldts";

/**
 * Lowercased hostname without `www.`, or null when the input is not an
 * http(s) URL. Internationalised names come back in punycode (the URL parser
 * does that), so a look-alike such as "gооgle.com" with Cyrillic letters is
 * "xn--ggle-55da.com" here and never equals "google.com".
 */
export function normalizeHost(input: string | null | undefined): string | null {
  if (!input) return null;
  let value = input.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const host = url.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
    if (!host.includes(".") && host !== "localhost") return null;
    return host;
  } catch {
    return null;
  }
}

function isIpOrLocal(host: string): boolean {
  return host === "localhost" || parse(host).isIp === true;
}

/**
 * The registrable domain ("eTLD+1") from the Public Suffix List, private
 * section included: "a.b.example.co.uk" → "example.co.uk", and
 * "alice.github.io" → "alice.github.io" (each user's site is its own domain).
 * IP addresses and localhost are their own domain. Null when the host is a
 * bare public suffix ("co.uk", "github.io"), so nothing can match on it.
 */
export function registrableDomain(host: string): string | null {
  if (isIpOrLocal(host)) return host;
  return getDomain(host, { allowPrivateDomains: true }) ?? null;
}

/**
 * Sites that share one account under different domains: a Gmail login is
 * for accounts.google.com too. Each group is one sign-in system, run by one
 * company; nothing here crosses companies.
 */
const EQUIVALENT_DOMAINS: readonly (readonly string[])[] = [
  ["google.com", "gmail.com", "googlemail.com", "youtube.com", "google.co.uk", "google.co.in"],
  ["apple.com", "icloud.com", "me.com"],
  [
    "microsoft.com",
    "microsoftonline.com",
    "live.com",
    "outlook.com",
    "hotmail.com",
    "office.com",
    "office365.com",
    "msn.com",
    "skype.com",
    "xbox.com",
    "azure.com",
    "bing.com",
  ],
  ["amazon.com", "amazon.co.uk", "amazon.de", "amazon.in", "amazon.ca", "amazon.com.au"],
  ["facebook.com", "messenger.com"],
  ["atlassian.com", "atlassian.net", "bitbucket.org", "trello.com"],
  ["paypal.com", "paypal.me"],
  ["yahoo.com", "aol.com"],
];

/** The registrable domains that share an account with this one, itself first. */
export function equivalentDomains(domain: string | null): string[] {
  if (!domain) return [];
  const group = EQUIVALENT_DOMAINS.find((g) => g.includes(domain));
  return group ? [domain, ...group.filter((d) => d !== domain)] : [domain];
}

/** Other names a site's logins are often saved under (without a website). */
const SITE_NAMES: Record<string, readonly string[]> = {
  "google.com": ["google", "gmail", "gsuite", "g suite", "workspace", "youtube"],
  "apple.com": ["apple", "icloud"],
  "microsoft.com": ["microsoft", "outlook", "office", "hotmail", "azure"],
  "facebook.com": ["facebook", "meta"],
  "atlassian.com": ["atlassian", "jira", "confluence", "bitbucket", "trello"],
};

/**
 * Words to look for in the names of logins saved without a website, for a
 * page on this host: "accounts.google.com" → google, gmail, gsuite…
 */
export function siteKeywords(host: string | null): string[] {
  const domain = host ? registrableDomain(host) : null;
  if (!domain || isIpOrLocal(domain)) return [];
  const words = new Set<string>();
  for (const d of equivalentDomains(domain)) {
    const label = d.split(".")[0];
    if (label && label.length >= 3) words.add(label);
    for (const w of SITE_NAMES[d] ?? []) words.add(w);
  }
  return [...words];
}

export type HostMatch = "exact" | "domain" | null;

/**
 * How an item's saved host relates to the page the user is on.
 *
 * "exact": same host. "domain": different hosts under the same registrable
 * domain (login.example.com vs example.com). IP addresses and localhost
 * match only exactly. Anything else, including look-alike and punycode
 * domains, is null.
 */
export function matchHost(savedHost: string | null, pageHost: string | null): HostMatch {
  if (!savedHost || !pageHost) return null;
  if (savedHost === pageHost) return "exact";
  if (isIpOrLocal(savedHost) || isIpOrLocal(pageHost)) return null;
  const saved = registrableDomain(savedHost);
  const page = registrableDomain(pageHost);
  if (saved === null || page === null) return null;
  // Same site, or one sign-in system under several domains (gmail.com ↔ google.com).
  return saved === page || equivalentDomains(page).includes(saved) ? "domain" : null;
}

/**
 * Whether a credential saved for `savedUrl` may be filled into `pageUrl`.
 * The host must match (see matchHost), and a login saved for an https site
 * is never filled into a page served over plain http, except localhost.
 */
export function canFill(
  savedUrl: string | null,
  savedHost: string | null,
  pageUrl: string,
): boolean {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  const pageHost = normalizeHost(pageUrl);
  if (!matchHost(savedHost, pageHost)) return false;
  if (page.protocol === "https:") return true;
  if (page.protocol !== "http:") return false;
  if (pageHost === "localhost" || pageHost === "127.0.0.1") return true;
  // Plain http on a public host: only if the login itself was saved as http.
  return !!savedUrl && /^http:\/\//i.test(savedUrl.trim());
}

export function isValidUrl(input: string): boolean {
  return normalizeHost(input) !== null;
}
