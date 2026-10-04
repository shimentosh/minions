// Live check of the DeepSeek integration with a harmless sample.
//   pnpm --filter @minions/api build && pnpm --filter @minions/api ai:check
// Uses the same client, sanitiser and safety gate as the API.
require("dotenv/config");
const { sanitizeForAi, getItemType } = require("@minions/core");
const { DeepSeekClient } = require("../dist/ai/deepseek.client");
const { AiService } = require("../dist/ai/ai.module");

(async () => {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY is not set in apps/api/.env");
    process.exit(2);
  }
  const client = new DeepSeekClient();
  const payload = sanitizeForAi({
    name: "Hetzner box",
    text: "VPS for the ClipMesh backend, production",
    host: "console.hetzner.cloud",
    projects: ["ClipMesh", "uContents"],
    collections: ["Servers", "Development"],
  });
  console.log("Sending (sanitised):", JSON.stringify(payload));
  const started = Date.now();
  const raw = await client.completeJson(
    'You organise entries in a password vault. Reply with JSON: {"type": an item type like SERVER|LOGIN|API_KEY, "project": string|null, "collection": string|null, "environment": string|null, "tags": string[], "confidence": number}.',
    payload,
  );
  if (!raw) {
    console.error("No usable answer (see warnings above).");
    process.exit(1);
  }
  const parsed = new AiService({}, client).parse(raw, ["ClipMesh", "uContents"]);
  console.log(`Answer in ${Date.now() - started} ms:`, raw);
  console.log("After validation:", parsed, parsed && getItemType(parsed.type) ? "" : "(rejected)");
})();
