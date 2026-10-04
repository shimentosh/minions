import { MailWarning } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

/** Shown until the account's email address is confirmed. */
export function VerifyEmailBanner() {
  const me = useSession((s) => s.me);
  const [busy, setBusy] = useState(false);
  if (!me || me.user.emailVerified) return null;

  const resend = async () => {
    setBusy(true);
    try {
      const r = await post<{ sent: boolean }>("/auth/email/verify-request");
      if (r.sent) toast.success("Link sent", `Check ${me.user.email}.`);
      else toast.error("The email could not be sent. Try again later.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-amber-500/20 border-b bg-amber-500/8 px-4 py-2 text-amber-800 text-sm dark:text-amber-300">
      <MailWarning className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        Confirm your email address. We sent a link to <strong>{me.user.email}</strong>. Until then
        you can't join workspaces.
      </span>
      <Button size="xs" variant="outline" loading={busy} onClick={() => void resend()}>
        Resend link
      </Button>
    </div>
  );
}
