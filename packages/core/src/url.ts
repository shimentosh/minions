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
  return saved !== null && saved === registrableDomain(pageHost) ? "domain" : null;
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
