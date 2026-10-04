import { findSecrets } from "@minions/core";
import { Injectable, Logger } from "@nestjs/common";
import { loadConfig } from "../config";

export class UnsafeAiPayloadError extends Error {
  constructor() {
    super("Refused to send a payload that contains secret-shaped content");
  }
}

/**
 * The only code that talks to DeepSeek. It takes an already sanitised
 * payload and checks it once more right before it leaves: if anything in the
 * serialised request still looks like a secret, nothing is sent.
 */
@Injectable()
export class DeepSeekClient {
  private readonly logger = new Logger("DeepSeek");

  get available(): boolean {
    return !!loadConfig().deepseek.apiKey;
  }

  /** Exposed for tests: the exact body that would be sent. */
  buildBody(system: string, payload: Record<string, unknown>) {
    const cfg = loadConfig().deepseek;
    return {
      model: cfg.model,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
    };
  }

  assertSafe(body: unknown): void {
    // The system prompt is ours and fixed; scan the user content.
    const user = (body as { messages: { role: string; content: string }[] }).messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    if (findSecrets(user).length > 0 || /\d{9,}/.test(user.replace(/\s/g, "")))
      throw new UnsafeAiPayloadError();
  }

  async completeJson(
    system: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const cfg = loadConfig().deepseek;
    if (!cfg.apiKey) return null;
    const body = this.buildBody(system, payload);
    this.assertSafe(body);
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        this.logger.warn(`DeepSeek responded ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;
      return JSON.parse(content) as Record<string, unknown>;
    } catch (e) {
      this.logger.warn(`DeepSeek request failed: ${e instanceof Error ? e.name : "error"}`);
      return null;
    }
  }
}
