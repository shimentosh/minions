import { describe, expect, it } from "vitest";
import { analyzeCapture, classify, confidenceBand } from "./classify";
import { findSecrets, luhnValid, redactSecrets, sanitizeForAi } from "./detect";
import { base32Encode, utf8 } from "./encoding";
import { parseDotenv, toDotenv } from "./env";
import { analyzeImport } from "./import/analyze";
import { parseCsv } from "./import/csv";
import { parseImport } from "./import/normalize";
import { getItemType, ITEM_TYPES, resolveField } from "./item-types";
import { estimateStrength, generatePassword } from "./password";
import { generateTotp, parseTotp, verifyTotp } from "./totp";
import { matchHost, normalizeHost } from "./url";

describe("TOTP (RFC 6238 vectors)", () => {
  const secret = base32Encode(utf8("12345678901234567890"));
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ])("t=%i", async (t, expected) => {
    const { code } = await generateTotp(
      { secret, algorithm: "SHA1", digits: 8, period: 30 },
      t * 1000,
    );
    expect(code).toBe(expected);
  });

  it("parses otpauth URIs", () => {
    const c = parseTotp(
      "otpauth://totp/Google:me%40gmail.com?secret=JBSWY3DPEHPK3PXP&issuer=Google&digits=6",
    );
    expect(c).toMatchObject({ issuer: "Google", account: "me@gmail.com", digits: 6, period: 30 });
  });

  it("verifies within the window and rejects others", async () => {
    const now = 1_700_000_000_000;
    const { code } = await generateTotp("JBSWY3DPEHPK3PXP", now - 30_000);
    expect(await verifyTotp("JBSWY3DPEHPK3PXP", code, now)).not.toBeNull();
    expect(await verifyTotp("JBSWY3DPEHPK3PXP", code, now + 120_000)).toBeNull();
  });
});

describe("password generator and strength", () => {
  it("honours length and character sets", () => {
    const pw = generatePassword({
      length: 32,
      uppercase: false,
      lowercase: true,
      numbers: true,
      symbols: false,
    });
    expect(pw).toHaveLength(32);
    expect(pw).toMatch(/^[a-z0-9]+$/);
    expect(pw).toMatch(/[0-9]/);
  });

  it("scores common and strong passwords apart", () => {
    expect(estimateStrength("password").score).toBe(0);
    expect(estimateStrength("Summer2024").score).toBeLessThanOrEqual(2);
    expect(estimateStrength(generatePassword()).score).toBe(4);
  });
});

describe("secret detection", () => {
  it("finds provider keys, cards and assignments", () => {
    const text =
      "openai sk-proj-abcdefghijklmnopqrstuvwxyz123456 card 4111 1111 1111 1111 password: hunter2!";
    const kinds = findSecrets(text).map((s) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(["api_key", "card", "password"]));
    const red = redactSecrets(text);
    expect(red).not.toContain("sk-proj");
    expect(red).not.toContain("4111");
    expect(red).not.toContain("hunter2");
  });

  it("luhn", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });

  it("sanitizeForAi removes every secret shape and non-string input", () => {
    const out = sanitizeForAi({
      text: "Stripe live key sk_live_51Habcdefghijklmnopqrstu for ClipMesh, bank 1234567890123",
      name: "AWS AKIAABCDEFGHIJKLMNOP",
      nested: { password: "x" },
      n: 42,
    } as Record<string, unknown>);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/sk_live|AKIA|1234567890123/);
    expect(out).not.toHaveProperty("nested");
    expect(out).not.toHaveProperty("n");
    expect(out.text).toContain("ClipMesh");
  });
});

describe("classification", () => {
  it("quick capture: Cloudflare production token for ClipMesh", () => {
    const r = analyzeCapture("Cloudflare production token for ClipMesh", {
      projects: ["ClipMesh", "uContents"],
    });
    expect(r.classification).toMatchObject({
      provider: "Cloudflare",
      project: "ClipMesh",
      environment: "Production",
    });
    expect(["API_KEY", "SECRET", "CLOUD"]).toContain(r.classification.type);
  });

  it("quick capture: YouTube login", () => {
    const r = analyzeCapture("My new YouTube login is me@gmail.com password: Tr0ub4dor&3xyz");
    expect(r.classification.type).toBe("LOGIN");
    expect(r.classification.provider).toBe("YouTube");
    expect(r.email).toBe("me@gmail.com");
    expect(r.secrets.map((s) => s.value)).toContain("Tr0ub4dor&3xyz");
    expect(r.safeText).not.toContain("Tr0ub4dor");
  });

  it("quick capture: credit card", () => {
    const r = analyzeCapture("This is my new credit card 4111 1111 1111 1111");
    expect(r.classification.type).toBe("CREDIT_CARD");
    expect(r.card).toEqual({ brand: "Visa", last4: "1111" });
  });

  it("learned preferences override rules", () => {
    const prefs = [
      {
        matchKey: "provider:cloudflare",
        target: "collection" as const,
        value: "Infrastructure",
        weight: 3,
      },
    ];
    const r = classify({ name: "Cloudflare DNS token" }, { preferences: prefs });
    expect(r.collection).toBe("Infrastructure");
    expect(r.source).toBe("preferences");
  });

  it("confidence bands", () => {
    expect(confidenceBand(0.94)).toBe("high");
    expect(confidenceBand(0.72)).toBe("medium");
    expect(confidenceBand(0.3)).toBe("low");
  });
});

describe("registry", () => {
  it("marks every secret-bearing field sensitive", () => {
    const secretKinds = new Set(["password", "secret", "totp", "card-number", "cvv"]);
    for (const t of ITEM_TYPES)
      for (const f of t.fields)
        if (secretKinds.has(f.kind)) expect(f.sensitive, `${t.type}.${f.key}`).toBe(true);
    for (const t of ITEM_TYPES) {
      const n = t.fields.find((f) => f.key === "notes");
      if (n) expect(n.sensitive).toBe(true);
    }
  });

  it("resolves dynamic env vars and rejects unknown keys", () => {
    expect(resolveField("ENVIRONMENT", "var.DATABASE_URL")?.def.sensitive).toBe(true);
    expect(resolveField("LOGIN", "var.X")).toBeNull();
    expect(resolveField("LOGIN", "nonsense")).toBeNull();
    expect(getItemType("CREDIT_CARD")?.financial).toBe(true);
  });
});

describe("url matching", () => {
  it("normalises and matches", () => {
    expect(normalizeHost("https://www.GitHub.com/login")).toBe("github.com");
    expect(normalizeHost("javascript:alert(1)")).toBeNull();
    expect(matchHost("accounts.google.com", "mail.google.com")).toBe("domain");
    expect(matchHost("github.com", "github.com")).toBe("exact");
    expect(matchHost("example.co.uk", "other.co.uk")).toBeNull();
  });
});

describe("imports", () => {
  it("parses quoted CSV", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
    ]);
  });

  it("parses a Chrome export", () => {
    const { source, records } = parseImport(
      "name,url,username,password,note\nGitHub,https://github.com/login,me,pw1,\n",
      "auto",
    );
    expect(source).toBe("chrome");
    expect(records[0]).toMatchObject({
      type: "LOGIN",
      host: "github.com",
      fields: { username: "me", password: "pw1" },
    });
  });

  it("normalises a mixed Notion table and groups the Google family", () => {
    const csv = [
      "Name,Email,Password,URL,2FA,Backup codes,Type",
      "Google password,me@gmail.com,pw-google,https://accounts.google.com,,,",
      "Gmail login,me@gmail.com,pw-google,https://mail.google.com,,,",
      "YouTube password,me@gmail.com,pw-google,https://youtube.com,,,",
      "Google 2FA,me@gmail.com,,,JBSWY3DPEHPK3PXP,,",
      "Google Backup codes,me@gmail.com,,,,1111 2222 3333,",
      "Stripe key,,,,,,api key",
    ].join("\n");
    const { records } = parseImport(csv, "notion");
    expect(records.map((r) => r.type)).toEqual([
      "LOGIN",
      "LOGIN",
      "LOGIN",
      "TOTP",
      "RECOVERY_CODE",
      "API_KEY",
    ]);
    const analysis = analyzeImport(records);
    const google = analysis.groups.find((g) => g.family === "google");
    expect(google?.canonical).toBe("Google Account");
    expect(google?.memberRefs.length).toBe(4);
    expect(analysis.duplicatesInFile.length).toBe(1);
  });
});

describe("dotenv", () => {
  it("round-trips", () => {
    const pairs = parseDotenv('# c\nA=1\nexport B="two words"\nC=x # note\n');
    expect(pairs).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two words" },
      { key: "C", value: "x" },
    ]);
    expect(parseDotenv(toDotenv(pairs))).toEqual(pairs);
  });
});

describe("provider tokens", () => {
  it("a token at a known service is an API key", () => {
    const r = analyzeCapture("Cloudflare production token for ClipMesh", {
      projects: ["ClipMesh"],
    });
    expect(r.classification.type).toBe("API_KEY");
    expect(r.classification.confidence).toBeGreaterThanOrEqual(0.85);
  });
});
