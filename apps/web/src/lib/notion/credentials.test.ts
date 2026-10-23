import { describe, expect, it } from "vitest";
import { detectCredentials, detectRowCredential, redactLines, tokenFor } from "./credentials";

const ctx = () => {
  let n = 0;
  return { nodeKey: "page", title: "Accounts", nextId: () => `c${n++}` };
};

describe("finding credentials in pages", () => {
  it("groups label: value lines into one login, named by the heading above", () => {
    const lines = [
      "## GitHub",
      "",
      "URL: https://github.com/login",
      "",
      "**Email**: me@acme.test",
      "",
      "Password: hunter2!x",
      "",
      "Some notes about it.",
    ];
    const [c, ...rest] = detectCredentials(lines, ctx());
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ type: "LOGIN", name: "GitHub", source: "text" });
    expect(c!.values).toMatchObject({
      url: "https://github.com/login",
      email: "me@acme.test",
      password: "hunter2!x",
    });
    expect(c!.spans).toEqual([{ line: 6, raw: "hunter2!x" }]);
  });

  it("splits two accounts and leaves ordinary prose alone", () => {
    const lines = [
      "Username: alice",
      "Password: one-1!",
      "Username: bob",
      "Password: two-2!",
      "",
      "We changed the password policy last year.",
      "Remember to reset your password every quarter.",
    ];
    const found = detectCredentials(lines, ctx());
    expect(found.map((c) => c.values.password)).toEqual(["one-1!", "two-2!"]);
    expect(found.map((c) => c.values.username)).toEqual(["alice", "bob"]);
  });

  it("reads markdown tables with a password column, one item per row", () => {
    const lines = [
      "| Service | Username | Password |",
      "| --- | --- | --- |",
      "| Figma | d@acme.test | S3cret\\_x |",
      "| Slack | s@acme.test |  |",
    ];
    const found = detectCredentials(lines, ctx());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ source: "table", name: "Figma" });
    // Markdown escapes are undone in the value that goes to the vault.
    expect(found[0]!.values.password).toBe("S3cret_x");
  });

  it("finds provider keys and private keys in code blocks", () => {
    const lines = [
      "Billing: sk_" + "live_51HxYzAbCdEfGhIjKlMnOpQr",
      "```",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
      "-----END OPENSSH PRIVATE KEY-----",
      "```",
    ];
    const found = detectCredentials(lines, ctx());
    expect(found.map((c) => c.type).sort()).toEqual(["API_KEY", "SSH_KEY"]);
    const ssh = found.find((c) => c.type === "SSH_KEY")!;
    expect(ssh.values.private_key).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(found.find((c) => c.type === "API_KEY")!.values).toMatchObject({ provider: "Stripe" });
  });

  it("takes the secrets out of the text, leaving a token", () => {
    const lines = [
      "Email: me@acme.test",
      "Password: hunter2!x",
      "```",
      "-----BEGIN RSA PRIVATE KEY-----",
      "abc",
      "-----END RSA PRIVATE KEY-----",
      "```",
    ];
    const found = detectCredentials(lines, ctx());
    const out = redactLines(lines, found).join("\n");
    expect(out).not.toContain("hunter2!x");
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).toContain("Email: me@acme.test");
    for (const c of found) expect(out).toContain(tokenFor(c.id));
  });

  it("recognises credential databases by their columns", () => {
    const columns = ["Name", "URL", "Username", "Password"];
    const row = { Name: "GitHub", URL: "https://github.com", Username: "dev", Password: "pw-1!" };
    const c = detectRowCredential(row, columns, { ...ctx(), title: "GitHub" })!;
    expect(c).toMatchObject({ type: "LOGIN", name: "GitHub", secretColumns: ["Password"] });
    expect(c.values).toMatchObject({
      url: "https://github.com",
      username: "dev",
      password: "pw-1!",
    });
    expect(detectRowCredential({ Name: "x", Password: "" }, columns, ctx())).toBeNull();
    expect(detectRowCredential({ Name: "x", Notes: "y" }, ["Name", "Notes"], ctx())).toBeNull();
  });
});
