import { estimateStrength } from "@minions/core";
import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { AuthLayout, FormError, PasswordInput, StrengthBar } from "@/components/auth/auth-screens";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, post } from "@/lib/api";
import { useSession } from "@/lib/session";

type State =
  | { kind: "checking" }
  | { kind: "invalid"; error: string }
  | { kind: "ready"; token: string; email: string; twoFactorRequired: boolean };

let linkToken: string | null = null;

/**
 * The token from the address bar, read once per page load: React may run
 * effects twice (StrictMode), and the first read removes it from the URL.
 * The router's history state is kept so it stays in sync.
 */
function takeLinkToken(): string {
  if (linkToken === null) {
    linkToken = window.location.hash.slice(1);
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }
  return linkToken;
}

/**
 * Opened from the reset email. Like email verification, the token is in the
 * URL fragment, which the browser never sends to a server, and it leaves the
 * address bar at once. The new keys are made here, as at sign-up; the server
 * then deletes everything the old ones protected.
 */
export function ResetAccountPage({ onDone }: { onDone: () => void }) {
  const resetAccount = useSession((s) => s.resetAccount);
  const [state, setState] = useState<State>({ kind: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = takeLinkToken();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setState({
        kind: "invalid",
        error: "This link is incomplete. Open it again from the email.",
      });
      return;
    }
    post<{ email: string; twoFactorRequired: boolean }>("/auth/reset/check", { token }).then(
      (r) => setState({ kind: "ready", token, ...r }),
      (e) => setState({ kind: "invalid", error: errorMessage(e) }),
    );
  }, []);

  if (state.kind === "checking") return <AuthLayout title="Checking your link…">{null}</AuthLayout>;

  if (state.kind === "invalid")
    return (
      <AuthLayout title="This link can't be used" subtitle={state.error}>
        <Button
          className="w-full"
          variant="outline"
          onClick={() => window.location.assign("/forgot-password")}
        >
          Request a new link
        </Button>
      </AuthLayout>
    );

  const strength = estimateStrength(password);
  const canReset =
    understood &&
    password.length >= 12 &&
    strength.score >= 3 &&
    password === confirm &&
    (!state.twoFactorRequired || code.trim().length >= 6);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state.kind !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      await resetAccount({
        token: state.token,
        password,
        code: state.twoFactorRequired ? code.trim() : undefined,
      });
      setPassword("");
      setConfirm("");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      return;
    }
    // No reload: the new vault key lives only in this page's memory.
    onDone();
  }

  return (
    <AuthLayout title="Reset your account" subtitle={state.email}>
      <form className="space-y-4" onSubmit={submit}>
        <div className="flex gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="font-medium text-destructive-foreground">
              Your current vault will be deleted
            </p>
            <p className="text-muted-foreground text-xs">
              Every password, note, share and device is removed, and two-factor sign-in is turned
              off. Workspaces you own pass to an admin, or are deleted if you are their only member.
              This can't be undone.
            </p>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-password">New master password</Label>
          <PasswordInput
            id="new-password"
            value={password}
            onChange={setPassword}
            autoFocus
            autoComplete="new-password"
          />
          <StrengthBar password={password} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-password">Confirm master password</Label>
          <PasswordInput
            id="confirm-password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
          />
          {confirm && confirm !== password && (
            <p className="text-destructive-foreground text-xs">Passwords don't match</p>
          )}
        </div>
        {state.twoFactorRequired && (
          <div className="space-y-1.5">
            <Label htmlFor="reset-code">Two-factor code</Label>
            <Input
              id="reset-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              placeholder="123456"
              className="font-mono tracking-widest"
            />
            <p className="text-muted-foreground text-xs">
              From your authenticator app, or one of your recovery codes.
            </p>
          </div>
        )}
        <Label className="flex items-start gap-2.5 font-normal text-sm leading-snug">
          <Checkbox
            checked={understood}
            onCheckedChange={(v) => setUnderstood(v === true)}
            className="mt-0.5"
          />
          I understand my old vault is deleted and can't be recovered.
        </Label>
        <FormError error={error} />
        <Button
          type="submit"
          variant="destructive"
          className="w-full"
          loading={busy}
          disabled={!canReset}
        >
          Delete vault and reset
        </Button>
        {busy && (
          <p className="text-center text-muted-foreground text-xs">
            Deriving your new keys on this device…
          </p>
        )}
        <button
          type="button"
          className="w-full text-center text-muted-foreground text-sm hover:text-foreground"
          onClick={() => window.location.assign("/login")}
        >
          I remembered it, back to sign in
        </button>
      </form>
    </AuthLayout>
  );
}
