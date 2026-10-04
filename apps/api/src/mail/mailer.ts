import { Injectable, Logger } from "@nestjs/common";
import { loadConfig } from "../config";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/** Mail sent while NODE_ENV=test, for the integration tests to read. Never filled otherwise. */
export const testOutbox: OutgoingMail[] = [];

/** Fixed endpoint: the server never sends mail requests anywhere configurable. */
const RESEND_URL = "https://api.resend.com/emails";

/**
 * Sends mail through the Resend API (RESEND_API_KEY). Mail bodies can hold
 * single-use links, so they are never logged; failures log only the HTTP
 * status. Without a key (allowed outside production) nothing is sent and a
 * one-line notice says so.
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
    if (!cfg.mail.resendApiKey) {
      this.logger.warn("RESEND_API_KEY is not set; an email was not sent");
      return false;
    }
    try {
      const res = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.mail.resendApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: cfg.mail.from,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.logger.error(`Resend refused the email (HTTP ${res.status})`);
      return res.ok;
    } catch (e) {
      this.logger.error(`Sending failed: ${e instanceof Error ? e.name : "error"}`);
      return false;
    }
  }
}
