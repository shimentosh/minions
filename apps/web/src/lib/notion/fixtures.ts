import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import type { ExportFile } from "./zip";

/**
 * A small Notion workspace export, shaped like the real ones (Markdown & CSV,
 * "Create folders for subpages" on), for tests. Ids are 32 hex characters.
 */

export const ID = {
  handbook: "11111111111111111111111111111111",
  onboarding: "22222222222222222222222222222222",
  accounts: "33333333333333333333333333333333",
  github: "44444444444444444444444444444444",
  stripe: "55555555555555555555555555555555",
  servers: "66666666666666666666666666666666",
};

export const SECRETS = {
  github: "gh-Pa55word!2024",
  stripe: "sk_" + "live_51HxYzAbCdEfGhIjKlMnOpQr",
  wifi: "Hunter2Wifi!",
  table: "S3cret-table-pass",
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

export function workspaceFiles(): Record<string, string | Uint8Array> {
  const root = "Export-abc";
  const hb = `${root}/Company Handbook ${ID.handbook}`;
  const hbLink = `Company%20Handbook%20${ID.handbook}`;
  const accountsCsv = `Name,URL,Username,Password,Tags\nGitHub,https://github.com,dev@acme.test,${SECRETS.github},engineering\nStripe,https://dashboard.stripe.com,,,billing\n`;
  return {
    [`${root}/Company Handbook ${ID.handbook}.md`]: [
      "# Company Handbook",
      "",
      `Welcome! Start with [Onboarding](${hbLink}/Onboarding%20${ID.onboarding}.md).`,
      "",
      "<aside>💡 Ask in #general if you are stuck.</aside>",
      "",
      "## Office wifi",
      "",
      "Network: Office",
      "",
      `Password: ${SECRETS.wifi}`,
      "",
      `![Floor plan](${hbLink}/floor.png)`,
      "",
      "- [x] Read this page",
      "- [ ] Meet the team",
      "",
      "| Service | Username | Password |",
      "| --- | --- | --- |",
      `| Figma | design@acme.test | ${SECRETS.table} |`,
      "",
      `See the [Accounts](${hbLink}/Accounts%20${ID.accounts}.csv) database.`,
    ].join("\n"),
    [`${hb}/floor.png`]: PNG,
    [`${hb}/Onboarding ${ID.onboarding}.md`]:
      "# Onboarding\n\nDay one: laptop, accounts, coffee.\n",
    [`${hb}/Accounts ${ID.accounts}.csv`]: accountsCsv,
    [`${hb}/Accounts ${ID.accounts}_all.csv`]: accountsCsv,
    [`${hb}/Accounts ${ID.accounts}/GitHub ${ID.github}.md`]: [
      "# GitHub",
      "",
      "URL: https://github.com",
      "Username: dev@acme.test",
      `Password: ${SECRETS.github}`,
      "Tags: engineering",
      "",
      "Org owner account. Keep 2FA on.",
    ].join("\n"),
    [`${hb}/Accounts ${ID.accounts}/Stripe ${ID.stripe}.md`]: [
      "# Stripe",
      "",
      "URL: https://dashboard.stripe.com",
      "Tags: billing",
      "",
      `Live key: ${SECRETS.stripe}`,
    ].join("\n"),
    [`${root}/Servers ${ID.servers}.md`]: [
      "# Servers",
      "",
      "Deploy key:",
      "",
      "```",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
      "-----END OPENSSH PRIVATE KEY-----",
      "```",
    ].join("\n"),
  };
}

const enc = new TextEncoder();

/** The fixture as ExportFile objects (no zip). */
export function exportFiles(files = workspaceFiles()): ExportFile[] {
  return Object.entries(files).map(([path, content]) => {
    const bytes = typeof content === "string" ? enc.encode(content) : content;
    return {
      path,
      size: bytes.length,
      bytes: async () => new Uint8Array(bytes),
      text: async () => (typeof content === "string" ? content : new TextDecoder().decode(bytes)),
    };
  });
}

/** The fixture as a real zip; `nested` puts it inside another zip, as split exports do. */
export async function exportZip(files = workspaceFiles(), nested = false): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter("application/zip"));
  for (const [path, content] of Object.entries(files))
    await writer.add(
      path,
      typeof content === "string" ? new TextReader(content) : new Uint8ArrayReader(content),
    );
  const zip = await writer.close();
  if (!nested) return zip;
  const outer = new ZipWriter(new BlobWriter("application/zip"));
  await outer.add(
    "Export-abc-Part-1.zip",
    new Uint8ArrayReader(new Uint8Array(await zip.arrayBuffer())),
  );
  return outer.close();
}
