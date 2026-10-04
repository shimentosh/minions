import { describe, expect, it } from "vitest";
import { smartFill } from "./smart-fill";

describe("smartFill", () => {
  it("site, email and password on one line", () => {
    const r = smartFill("github.com   me@gmail.com   Tr0ub4dor&3", "LOGIN");
    expect(r.values).toMatchObject({
      url: "https://github.com",
      email: "me@gmail.com",
      password: "Tr0ub4dor&3",
    });
    expect(r.name).toBe("GitHub");
  });

  it("email:password export format", () => {
    const r = smartFill("https://accounts.google.com\nme@gmail.com:hunter2!", "LOGIN");
    expect(r.values).toMatchObject({ email: "me@gmail.com", password: "hunter2!" });
  });

  it("labelled lines", () => {
    const r = smartFill(
      "Website: example.com\nUser: octo\nPass: s3cret!\n2FA: JBSWY3DPEHPK3PXP",
      "LOGIN",
    );
    expect(r.values).toMatchObject({
      url: "https://example.com",
      username: "octo",
      password: "s3cret!",
      totp: "JBSWY3DPEHPK3PXP",
    });
  });

  it("server with ip:port", () => {
    const r = smartFill("203.0.113.7:2222 root hunter2pass!", "SERVER");
    expect(r.values).toMatchObject({
      host: "203.0.113.7",
      port: "2222",
      username: "root",
      password: "hunter2pass!",
    });
  });

  it("domain with registrar", () => {
    const r = smartFill("Domain: clipmesh.com\nRegistrar: Namecheap", "DOMAIN");
    expect(r.values).toMatchObject({ domain: "clipmesh.com", registrar: "Namecheap" });
  });

  it("detects the type when none is given", () => {
    expect(smartFill("4111 1111 1111 1111 exp: 12/29 cvv: 123").type).toBe("CREDIT_CARD");
    const card = smartFill("4111 1111 1111 1111\nExpiry: 12/29\nCVV: 123", "CREDIT_CARD");
    expect(card.values).toMatchObject({
      number: "4111111111111111",
      exp_month: "12",
      exp_year: "2029",
      cvv: "123",
    });
  });

  it(".env blocks become variables", () => {
    const r = smartFill("DATABASE_URL=postgres://u:p@h/db\nOPENAI_API_KEY=sk-x", "ENVIRONMENT");
    expect(r.values).toEqual({
      "var.DATABASE_URL": "postgres://u:p@h/db",
      "var.OPENAI_API_KEY": "sk-x",
    });
  });

  it("API key with provider", () => {
    const r = smartFill("OpenAI sk-proj-abcdefghijklmnopqrstuvwxyz123456", "API_KEY");
    expect(r.values).toMatchObject({
      api_key: "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      provider: "OpenAI",
    });
  });
});

describe("smartFill type detection", () => {
  it("email + password at a registrar is a login", () => {
    const r = smartFill("namecheap.com  me@shimanto.dev  N4mecheap-Pass!");
    expect(r.type).toBe("LOGIN");
    expect(r.values).toMatchObject({
      url: "https://namecheap.com",
      email: "me@shimanto.dev",
      password: "N4mecheap-Pass!",
    });
  });
});

describe("card paste", () => {
  const cases: [string, Record<string, string>][] = [
    [
      "4111 1111 1111 1111 12/29 123 John Doe",
      {
        number: "4111111111111111",
        exp_month: "12",
        exp_year: "2029",
        cvv: "123",
        cardholder: "John Doe",
      },
    ],
    [
      "4111111111111111|12|2029|123",
      { number: "4111111111111111", exp_month: "12", exp_year: "2029", cvv: "123" },
    ],
    [
      "John Doe\n4111-1111-1111-1111\n12/29\n123",
      {
        number: "4111111111111111",
        exp_month: "12",
        exp_year: "2029",
        cvv: "123",
        cardholder: "John Doe",
      },
    ],
    [
      "Card: 5555 5555 5555 4444 Exp 08/27 CVV 321",
      { number: "5555555555554444", exp_month: "08", exp_year: "2027", cvv: "321" },
    ],
    [
      "4111111111111111 1229 123",
      { number: "4111111111111111", exp_month: "12", exp_year: "2029", cvv: "123" },
    ],
    [
      "Name on card: SHIMANTO AHMED\nNumber: 3782 822463 10005\nValid thru 03/2030\nCID 1234",
      {
        number: "378282246310005",
        exp_month: "03",
        exp_year: "2030",
        cvv: "1234",
        cardholder: "SHIMANTO AHMED",
      },
    ],
  ];
  it.each(cases)("%s", (text, expected) => {
    const r = smartFill(text, "CREDIT_CARD");
    expect(r.values).toEqual(expected);
  });

  it("detects a card without being told", () => {
    const r = smartFill("4111 1111 1111 1111 12/29 123");
    expect(r.type).toBe("CREDIT_CARD");
    expect(r.name).toBe("Visa •••• 1111");
  });
});

describe("login with 2FA", () => {
  it("a password next to a 2FA secret makes a login that keeps both", () => {
    const r = smartFill(
      "Website: staging.example.com\nUser: team@example.com\nPass: Sh4red-Staging-Pass!\n2FA: JBSWY3DPEHPK3PXP",
    );
    expect(r.type).toBe("LOGIN");
    expect(r.values).toMatchObject({
      url: "https://staging.example.com",
      email: "team@example.com",
      password: "Sh4red-Staging-Pass!",
      totp: "JBSWY3DPEHPK3PXP",
    });
  });

  it("a bare 2FA secret is still an authenticator entry", () => {
    expect(smartFill("GitHub 2FA JBSWY3DPEHPK3PXP").type).toBe("TOTP");
  });
});
