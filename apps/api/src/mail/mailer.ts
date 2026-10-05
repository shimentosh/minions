import { Injectable, Logger } from "@nestjs/common";
import { loadConfig } from "../config";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/** Mail sent while NODE_ENV=test, for the integration tests to read. Never filled otherwise. */
export const testOutbox: OutgoingMail[] = [];

/**
 * Fixed endpoint. The only configurable mail target is a Mailpit on this
 * machine, in development (see MAILPIT_URL in config.ts).
 */
const RESEND_URL = "https://api.resend.com/emails";

/** "Name <a@b.c>" or "a@b.c" → Mailpit's address shape. */
function mailpitAddress(from: string): { Email: string; Name?: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { Name: m[1] || undefined, Email: m[2] } : { Email: from.trim() };
}

/**
 * Sends mail through the Resend API (RESEND_API_KEY), or in development
 * through a local Mailpit (MAILPIT_URL, loopback only; it wins over Resend so
 * development never mails real inboxes). Mail bodies can hold single-use
 * links, so they are never logged; failures log only the HTTP status. With
 * neither set (allowed outside production) nothing is sent and a one-line
 * notice says so.
 */
@Injectable()
export class Mailer {
  private readonly logger = new Logger("Mail");

  async send(mail: OutgoingMail): Promise<boolean> {
    const cfg = loadConfig();
    if (cfg.env === "test") {
      testOutbox.push(mail);
      return true;
    }
    if (cfg.env === "development" && cfg.mail.mailpitUrl) {
      return this.post(
        "Mailpit",
        `${cfg.mail.mailpitUrl}/api/v1/send`,
        {},
        {
          From: mailpitAddress(cfg.mail.from),
          To: [{ Email: mail.to }],
          Subject: mail.subject,
          Text: mail.text,
        },
      );
    }
    if (!cfg.mail.resendApiKey) {
      this.logger.warn("RESEND_API_KEY is not set; an email was not sent");
      return false;
    }
    return this.post(
      "Resend",
      RESEND_URL,
      { authorization: `Bearer ${cfg.mail.resendApiKey}` },
      { from: cfg.mail.from, to: [mail.to], subject: mail.subject, text: mail.text },
    );
  }

  private async post(
    service: string,
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<boolean> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.logger.error(`${service} refused the email (HTTP ${res.status})`);
      return res.ok;
    } catch (e) {
      this.logger.error(
        `Sending through ${service} failed: ${e instanceof Error ? e.name : "error"}`,
      );
      return false;
    }
  }
}
