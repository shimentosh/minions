import { estimateStrength } from "@minions/core";
import { Eye, EyeOff, Fingerprint, Lock, MailCheck, ShieldCheck } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";

export function AuthLayout({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center overflow-y-auto bg-background px-gutter pt-[calc(--spacing(6)+env(safe-area-inset-top,0px))] pb-[calc(--spacing(6)+env(safe-area-inset-bottom,0px))] sm:py-10">
      <div className="my-auto w-full max-w-sm space-y-4">
        <div className="flex items-center justify-center gap-2">
          <img src="/minions.svg" alt="" className="size-8 rounded-lg" />
          <span className="font-semibold text-lg tracking-tight">Minions</span>
        </div>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">{title}</CardTitle>
            {subtitle ? <CardDescription>{subtitle}</CardDescription> : null}
          </CardHeader>
          <CardPanel className="pt-0">{children}</CardPanel>
        </Card>
        <p className="text-center text-muted-foreground text-xs">
          End-to-end encrypted. Your master password never leaves this device.
        </p>
      </div>
    </div>
  );
}

export function PasswordInput({
  id,
  value,
  onChange,
  autoFocus,
  autoComplete,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  autoComplete?: string;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        placeholder={placeholder}
        spellCheck={false}
        className="pe-9"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 end-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
        aria-label={show ? "Hide password" : "Show password"}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive-foreground text-sm">
      {error}
    </p>
  );
}

export function StrengthBar({ password }: { password: string }) {
  if (!password) return null;
  const s = estimateStrength(password);
  const colors = [
    "bg-red-500",
    "bg-orange-500",
    "bg-amber-500",
    "bg-emerald-500",
    "bg-emerald-600",
  ];
  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn("h-1 flex-1 rounded-full bg-muted", i <= s.score && colors[s.score])}
          />
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        {s.label}
        {s.warnings.length ? ` · ${s.warnings[0]}` : ""}
      </p>
    </div>
  );
}

function TwoFactorStep() {
  const verify = useSession((s) => s.verifyTwoFactor);
  const verifyPasskey = useSession((s) => s.verifyPasskey);
  const methods = useSession((s) => s.twoFactorMethods);
  const logout = useSession((s) => s.logout);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"code" | "passkey" | null>(null);
  const hasTotp = methods.includes("totp");
  const hasPasskey = methods.includes("passkey");

  async function run(kind: "code" | "passkey", fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Passkey prompt was cancelled."
          : errorMessage(err),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <AuthLayout
      title="Two-factor verification"
      subtitle={
        hasTotp
          ? "Use your passkey, or enter the code from your authenticator app (or a recovery code)."
          : "Confirm it's you with your passkey."
      }
    >
      <div className="space-y-4">
        {hasPasskey && (
          <Button
            className="w-full"
            loading={busy === "passkey"}
            onClick={() => void run("passkey", verifyPasskey)}
          >
            <Fingerprint /> Use a passkey
          </Button>
        )}
        {hasPasskey && hasTotp && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>
        )}
        {hasTotp && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run("code", () => verify(code));
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus={!hasPasskey}
                autoComplete="one-time-code"
                inputMode="text"
                placeholder="123456"
                className="font-mono tracking-widest"
              />
            </div>
            <Button
              type="submit"
              variant={hasPasskey ? "outline" : "default"}
              className="w-full"
              loading={busy === "code"}
              disabled={code.trim().length < 6}
            >
              <ShieldCheck /> Verify code
            </Button>
          </form>
        )}
        <FormError error={error} />
        <button
          type="button"
          className="w-full text-center text-muted-foreground text-xs hover:text-foreground"
          onClick={() => void logout()}
        >
          Use a different account
        </button>
      </div>
    </AuthLayout>
  );
}

/**
 * Forgotten master password. The vault is encrypted with it on this device,
 * so it cannot be recovered; the emailed link resets the account to an empty
 * vault instead. The answer is the same whether or not the account exists.
 */
function ForgotPassword({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/reset/request", { email: email.trim() });
      setSentTo(email.trim());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const back = (
    <button
      type="button"
      className="w-full text-center text-muted-foreground text-sm hover:text-foreground"
      onClick={onBack}
    >
      Back to sign in
    </button>
  );

  if (sentTo)
    return (
      <AuthLayout title="Check your email">
        <div className="space-y-4">
          <p className="flex gap-2.5 text-muted-foreground text-sm">
            <MailCheck className="mt-0.5 size-4 shrink-0 text-foreground" />
            <span>
              If <span className="font-medium text-foreground">{sentTo}</span> has a Minions
              account, a reset link is on its way. It works once and expires in 1 hour.
            </span>
          </p>
          <p className="text-muted-foreground text-xs">
            Remembered your password? Nothing changes until you open the link and confirm.
          </p>
          {back}
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout
      title="Forgot your master password?"
      subtitle="Nobody can recover it, not even the server. Your vault is encrypted with it on your device."
    >
      <form className="space-y-4" onSubmit={submit}>
        <div className="space-y-1.5 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
          <p className="font-medium">Before you reset</p>
          <ul className="list-disc space-y-1 ps-4 text-muted-foreground">
            <li>
              Check where you might have saved it: a browser, another password manager, paper.
            </li>
            <li>Try the variations you usually use: capitals, spaces, a number at the end.</li>
          </ul>
        </div>
        <p className="rounded-lg bg-warning/8 px-3 py-2 text-warning-foreground text-xs">
          Resetting deletes everything in your vault and starts an empty one on the same email.
          Workspaces you own pass to an admin, or are deleted if you are their only member.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="reset-email">Email</Label>
          <Input
            id="reset-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </div>
        <FormError error={error} />
        <Button type="submit" className="w-full" loading={busy} disabled={!email.includes("@")}>
          Email me a reset link
        </Button>
        {back}
      </form>
    </AuthLayout>
  );
}

export function SignInScreen() {
  const status = useSession((s) => s.status);
  const login = useSession((s) => s.login);
  const register = useSession((s) => s.register);
  const [mode, setMode] = useState<"login" | "register" | "forgot">(() =>
    window.location.pathname === "/register"
      ? "register"
      : window.location.pathname === "/forgot-password"
        ? "forgot"
        : "login",
  );
  // An invitation link (someone shared a password) carries the address it was sent to.
  const [invitedEmail] = useState(() =>
    window.location.pathname === "/register"
      ? (new URLSearchParams(window.location.search).get("email") ?? "").slice(0, 254)
      : "",
  );
  const [email, setEmail] = useState(() =>
    window.location.pathname === "/forgot-password"
      ? (new URLSearchParams(window.location.search).get("email") ?? "").slice(0, 254)
      : invitedEmail,
  );
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === "two-factor") return <TwoFactorStep />;
  if (mode === "forgot")
    return (
      <ForgotPassword
        initialEmail={email}
        onBack={() => {
          setMode("login");
          setError(null);
        }}
      />
    );

  const strength = estimateStrength(password);
  const canRegister =
    name.trim() &&
    email.includes("@") &&
    password.length >= 12 &&
    strength.score >= 3 &&
    password === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login({ email, password });
      else await register({ email, name, password });
      setPassword("");
      setConfirm("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={mode === "login" ? "Sign in to your vault" : "Create your vault"}
      subtitle={
        mode === "login"
          ? "Your master password unlocks everything. It is never sent to the server."
          : "Choose a master password you will remember. It cannot be recovered."
      }
    >
      <form className="space-y-4" onSubmit={submit}>
        {mode === "register" && invitedEmail && (
          <p className="rounded-lg bg-info/8 px-3 py-2 text-info-foreground text-sm dark:bg-info/16">
            Someone shared a password with you. Sign up with this email, confirm it, and it appears
            under Shared.
          </p>
        )}
        {mode === "register" && (
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="password">Master password</Label>
            {mode === "login" && (
              <button
                type="button"
                className="text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => {
                  setMode("forgot");
                  setPassword("");
                  setError(null);
                }}
              >
                Forgot password?
              </button>
            )}
          </div>
          <PasswordInput
            id="password"
            value={password}
            onChange={setPassword}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
          {mode === "register" && <StrengthBar password={password} />}
        </div>
        {mode === "register" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">Confirm master password</Label>
              <PasswordInput
                id="confirm"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
              />
              {confirm && confirm !== password && (
                <p className="text-destructive-foreground text-xs">Passwords don't match</p>
              )}
            </div>
            <p className="rounded-lg bg-warning/8 px-3 py-2 text-warning-foreground text-xs">
              Minions encrypts your vault with this password on your device. Nobody, including the
              server, can reset it or recover your data without it. Use at least 12 characters.
            </p>
          </>
        )}
        <FormError error={error} />
        <Button
          type="submit"
          className="w-full"
          loading={busy}
          disabled={mode === "login" ? !email || !password : !canRegister}
        >
          {mode === "login" ? "Sign in" : "Create vault"}
        </Button>
        {busy && (
          <p className="text-center text-muted-foreground text-xs">
            Deriving your keys on this device…
          </p>
        )}
        <p className="text-center text-muted-foreground text-sm">
          {mode === "login" ? "New to Minions? " : "Already have a vault? "}
          <button
            type="button"
            className="font-medium text-foreground underline-offset-4 hover:underline"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "Create a vault" : "Sign in"}
          </button>
        </p>
      </form>
    </AuthLayout>
  );
}

export function LockScreen() {
  const me = useSession((s) => s.me);
  const unlock = useSession((s) => s.unlock);
  const logout = useSession((s) => s.logout);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout title="Vault locked" subtitle={me ? `Signed in as ${me.user.email}` : undefined}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await unlock(password);
            setPassword("");
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="unlock-password">Master password</Label>
          <PasswordInput
            id="unlock-password"
            value={password}
            onChange={setPassword}
            autoFocus
            autoComplete="current-password"
          />
        </div>
        <FormError error={error} />
        <Button type="submit" className="w-full" loading={busy} disabled={!password}>
          <Lock /> Unlock
        </Button>
        <div className="flex items-center justify-center gap-3 text-muted-foreground text-xs">
          <button type="button" className="hover:text-foreground" onClick={() => void logout()}>
            Sign out
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            className="hover:text-foreground"
            onClick={() => {
              // The sign-in screen opens on the forgot-password step for this address.
              const q = me ? `?email=${encodeURIComponent(me.user.email)}` : "";
              window.history.replaceState(null, "", `/forgot-password${q}`);
              void logout();
            }}
          >
            Forgot password?
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}

export function Splash() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <img src="/minions.svg" alt="" className="size-10 animate-pulse rounded-xl" />
    </div>
  );
}
