import { describe, expect, it } from "vitest";
import { canFill, matchHost, normalizeHost, registrableDomain } from "./url";

describe("registrableDomain", () => {
  it("uses the public suffix list, not the last two labels", () => {
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("login.bank.co.kr")).toBe("bank.co.kr");
    expect(registrableDomain("shop.example.com.pk")).toBe("example.com.pk");
    expect(registrableDomain("www.example.com")).toBe("example.com");
  });

  it("treats private suffixes as suffixes, so each tenant is its own domain", () => {
    expect(registrableDomain("alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("x.alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("app.vercel.app")).toBe("app.vercel.app");
  });

  it("has no registrable domain for a bare suffix", () => {
    expect(registrableDomain("co.uk")).toBeNull();
    expect(registrableDomain("github.io")).toBeNull();
  });
});

describe("matchHost", () => {
  it("matches the same site and its subdomains", () => {
    expect(matchHost("github.com", "github.com")).toBe("exact");
    expect(matchHost("accounts.google.com", "mail.google.com")).toBe("domain");
    expect(matchHost("example.co.uk", "login.example.co.uk")).toBe("domain");
  });

  it("never matches across a public suffix", () => {
    expect(matchHost("example.co.uk", "other.co.uk")).toBeNull();
    expect(matchHost("bank.co.kr", "evil.co.kr")).toBeNull();
    expect(matchHost("bank.com.pk", "evil.com.pk")).toBeNull();
    expect(matchHost("alice.github.io", "mallory.github.io")).toBeNull();
    expect(matchHost("myapp.vercel.app", "phish.vercel.app")).toBeNull();
  });

  it("rejects look-alike domains", () => {
    expect(matchHost("paypal.com", "paypal.com.evil.net")).toBeNull();
    expect(matchHost("paypal.com", "paypa1.com")).toBeNull();
    expect(matchHost("paypal.com", "secure-paypal.com")).toBeNull();
    expect(matchHost("paypal.com", "paypal.co")).toBeNull();
  });

  it("rejects homographs: IDNs are compared in punycode", () => {
    // Cyrillic "о" (U+043E) instead of Latin "o".
    const lookalike = normalizeHost("https://gооgle.com/login");
    expect(lookalike).toMatch(/^xn--/);
    expect(matchHost("google.com", lookalike)).toBeNull();
    expect(matchHost("apple.com", normalizeHost("https://аpple.com"))).toBeNull();
  });

  it("does not let userinfo or paths fake the host", () => {
    expect(normalizeHost("https://google.com@evil.com/")).toBe("evil.com");
    expect(normalizeHost("https://evil.com/google.com")).toBe("evil.com");
    expect(matchHost("google.com", normalizeHost("https://google.com.evil.com"))).toBeNull();
  });

  it("matches IP addresses and localhost only exactly", () => {
    expect(matchHost("10.0.0.5", "10.0.0.5")).toBe("exact");
    expect(matchHost("10.0.0.5", "10.0.0.6")).toBeNull();
    expect(matchHost("1.2.3.4", "5.6.3.4")).toBeNull();
    expect(matchHost("localhost", "localhost")).toBe("exact");
  });

  it("rejects non-http schemes", () => {
    expect(normalizeHost("javascript:alert(1)")).toBeNull();
    expect(normalizeHost("file:///etc/passwd")).toBeNull();
    expect(normalizeHost("data:text/html,hi")).toBeNull();
  });
});

describe("canFill", () => {
  it("fills https pages of the saved site", () => {
    expect(canFill("https://github.com/login", "github.com", "https://github.com/session")).toBe(
      true,
    );
  });

  it("never fills an https login into a plain-http page", () => {
    expect(canFill("https://github.com", "github.com", "http://github.com/login")).toBe(false);
    expect(canFill(null, "github.com", "http://github.com/login")).toBe(false);
  });

  it("allows http only for logins saved as http, or for localhost", () => {
    expect(
      canFill("http://router.example.com", "router.example.com", "http://router.example.com"),
    ).toBe(true);
    expect(canFill(null, "localhost", "http://localhost:3000/login")).toBe(true);
  });

  it("refuses other sites and other schemes", () => {
    expect(canFill("https://github.com", "github.com", "https://github.com.evil.io")).toBe(false);
    expect(canFill("https://github.com", "github.com", "ftp://github.com")).toBe(false);
    expect(canFill("https://github.com", "github.com", "not a url")).toBe(false);
  });
});
