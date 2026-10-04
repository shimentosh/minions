import { CircleCheck, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage, post } from "@/lib/api";

/**
 * Opened from the link in the verification email. The token is in the URL
 * fragment, which the browser never sends to any server; it is taken out of
 * the address bar before anything else happens. Works signed in or not.
 */
export function VerifyEmailPage() {
  const [state, setState] = useState<"working" | "done" | { error: string }>("working");

  useEffect(() => {
    const token = window.location.hash.slice(1);
    window.history.replaceState(null, "", window.location.pathname);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setState({ error: "This link is incomplete. Open it again from the email." });
      return;
    }
    post("/auth/email/verify", { token }).then(
      () => setState("done"),
      (e) => setState({ error: errorMessage(e) }),
    );
  }, []);

  return (
    <div className="flex h-full w-full flex-col items-center overflow-y-auto bg-background px-gutter py-10">
      <div className="my-auto w-full max-w-md space-y-4">
        <div className="flex items-center justify-center gap-2">
          <img src="/minions.svg" alt="" className="size-8 rounded-lg" />
          <span className="font-semibold text-lg tracking-tight">Minions</span>
        </div>
        <Card>
          <CardHeader>
            {state === "working" ? (
              <CardTitle>Confirming your email…</CardTitle>
            ) : state === "done" ? (
              <>
                <CardTitle className="flex items-center gap-2">
                  <CircleCheck className="size-5 text-emerald-600" /> Email confirmed
                </CardTitle>
                <CardDescription>
                  Your address is verified. You can now accept workspace invitations sent to it.
                </CardDescription>
              </>
            ) : (
              <>
                <CardTitle className="flex items-center gap-2">
                  <TriangleAlert className="size-5 text-amber-600" /> Could not confirm
                </CardTitle>
                <CardDescription>{state.error}</CardDescription>
              </>
            )}
          </CardHeader>
          {state !== "working" && (
            <div className="px-6 pb-6">
              <Button size="sm" onClick={() => window.location.assign("/")}>
                Open Minions
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
