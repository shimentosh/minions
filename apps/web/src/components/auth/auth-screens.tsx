import { estimateStrength, normalizeBackupCode } from "@minions/core";
import { Eye, EyeOff, Fingerprint, Lock, Mail, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { checkBackupCode, requestPasswordReset, useSession } from "@/lib/session";

function AuthLayout({
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
        // Shown as text, a phone keyboard would capitalise or "correct" the password.
        autoCapitalize="none"
        autoCorrect="off"
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

function FormError({ error }: { error: string | null }) {
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
 * Forgotten master password. Usually a link sent to the account's email; a
 * backup code works too, for when email reset is off or the mailbox is out
 * of reach. Either way only the master password changes: items, workspaces
 * and shares stay as they are.
 */
function ForgotPassword({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const recover = useSession((s) => s.recover);
  const [step, setStep] = useState<"email" | "sent" | "backup">("email");
  const [email, setEmail] = useState(initialEmail);
  const [backupCode, setBackupCode] = useState("");
  const [checked, setChecked] = useState<{ twoFactorRequired: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  const back = (
    <button
      type="button"
      className="w-full text-center text-muted-foreground text-sm hover:text-foreground"
      onClick={onBack}
    >
      I remembered it, back to sign in
    </button>
  );

  const otherWay = (label: string, to: "email" | "backup") => (
    <button
      type="button"
      className="w-full text-center text-muted-foreground text-sm hover:text-foreground"
      onClick={() => {
        setError(null);
        setStep(to);
      }}
    >
      {label}
    </button>
  );

  if (step === "email")
    return (
      <AuthLayout
        title="Forgot your master password?"
        subtitle="We'll email you a link to set a new one. You can keep your vault, or start fresh."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await requestPasswordReset(email.trim());
              setStep("sent");
            });
          }}
        >
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
            <Mail /> Send reset link
          </Button>
          {otherWay("Use a backup code instead", "backup")}
          {back}
        </form>
      </AuthLayout>
    );

  if (step === "sent")
    return (
      <AuthLayout title="Check your email" subtitle={email.trim()}>
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            If this address has a Minions account, a reset link is on its way. It works once and
            expires in 1 hour. No email after a few minutes? Check your spam folder.
          </p>
          <Button variant="outline" className="w-full" onClick={() => setStep("email")}>
            Use a different email
          </Button>
          {otherWay("Use a backup code instead", "backup")}
          {back}
        </div>
      </AuthLayout>
    );

  if (!checked)
    return (
      <AuthLayout
        title="Use a backup code"
        subtitle="Set a new master password with one of the backup codes you saved. Your vault stays exactly as it is."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await checkBackupCode(email.trim(), backupCode);
              setChecked({ twoFactorRequired: r.twoFactorRequired });
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="recover-email">Email</Label>
            <Input
              id="recover-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus={!initialEmail}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="backup-code">Backup code</Label>
            <Input
              id="backup-code"
              value={backupCode}
              onChange={(e) => setBackupCode(e.target.value)}
              placeholder="xxxxx-xxxxx-xxxxx-xxxxx"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus={!!initialEmail}
              className="font-mono"
            />
            <p className="text-muted-foreground text-xs">
              From the list you saved when you made backup codes in Settings → Security.
            </p>
          </div>
          <FormError error={error} />
          <Button
            type="submit"
            className="w-full"
            loading={busy}
            disabled={!email.includes("@") || !normalizeBackupCode(backupCode)}
          >
            Continue
          </Button>
          {otherWay("Email me a reset link instead", "email")}
          {back}
        </form>
      </AuthLayout>
    );

  return (
    <NewPasswordForm
      subtitle="Your vault, workspaces and shares stay as they are. Other devices are signed out."
      twoFactorRequired={checked.twoFactorRequired}
      onSubmit={(password, code) => recover({ email: email.trim(), backupCode, password, code })}
      footer={back}
    />
  );
}

/**
 * The last step of a forgotten master password, from a backup code or an
 * emailed link: a new password, and the second factor when 2FA is on.
 */
function NewPasswordForm({
  subtitle,
  twoFactorRequired,
  onSubmit,
  footer,
  children,
  ready = true,
  submitLabel = "Set new master password",
  busyLabel = "Opening your vault on this device…",
}: {
  subtitle: string;
  twoFactorRequired: boolean;
  onSubmit: (password: string, code: string | undefined) => Promise<void>;
  footer: ReactNode;
  /** Shown above the password fields. */
  children?: ReactNode;
  /** False holds the submit button back, on top of the password checks. */
  ready?: boolean;
  submitLabel?: string;
  busyLabel?: string;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const strength = estimateStrength(password);
  const canSave =
    password.length >= 12 &&
    strength.score >= 3 &&
    password === confirm &&
    ready &&
    (!twoFactorRequired || code.trim().length >= 6);

  return (
    <AuthLayout title="Choose a new master password" subtitle={subtitle}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onSubmit(password, twoFactorRequired ? code.trim() : undefined);
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        {children}
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
        {twoFactorRequired && (
          <div className="space-y-1.5">
            <Label htmlFor="recover-2fa">Two-factor code</Label>
            <Input
              id="recover-2fa"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              placeholder="123456"
              className="font-mono tracking-widest"
            />
            <p className="text-muted-foreground text-xs">
              From your authenticator app, or one of your two-factor recovery codes.
            </p>
          </div>
        )}
        <FormError error={error} />
        <Button type="submit" className="w-full" loading={busy} disabled={!canSave}>
          {submitLabel}
        </Button>
        {busy && <p className="text-center text-muted-foreground text-xs">{busyLabel}</p>}
        {footer}
      </form>
    </AuthLayout>
  );
}

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

type ResetLink =
  | { kind: "checking" }
  | { kind: "invalid"; error: string }
  | {
      kind: "ready";
      token: string;
      email: string;
      twoFactorRequired: boolean;
      canKeepVault: boolean;
    };

/** One choice on the reset page, styled as a radio card. */
function ResetChoice({
  selected,
  onSelect,
  title,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full gap-3 rounded-lg border px-3 py-2.5 text-start transition-colors",
        selected ? "border-primary bg-primary/5" : "hover:bg-muted/50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          selected && "border-primary",
        )}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <span className="space-y-0.5">
        <span className="block font-medium text-sm">{title}</span>
        <span className="block text-muted-foreground text-xs">{children}</span>
      </span>
    </button>
  );
}

/**
 * Opened from the reset email. As with email verification, the token is in
 * the URL fragment, which the browser never sends to a server, and it leaves
 * the address bar at once.
 */
export function ResetPasswordPage({ onDone }: { onDone: () => void }) {
  const resetPassword = useSession((s) => s.resetPassword);
  const startOver = useSession((s) => s.startOver);
  const [link, setLink] = useState<ResetLink>({ kind: "checking" });
  const [keep, setKeep] = useState(true);
  const [understood, setUnderstood] = useState(false);

  useEffect(() => {
    const token = takeLinkToken();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setLink({ kind: "invalid", error: "This link is incomplete. Open it again from the email." });
      return;
    }
    post<{ email: string; twoFactorRequired: boolean; canKeepVault: boolean }>(
      "/auth/reset/check",
      { token },
    ).then(
      (r) => {
        setLink({
          kind: "ready",
          token,
          email: r.email,
          twoFactorRequired: r.twoFactorRequired,
          canKeepVault: r.canKeepVault,
        });
        setKeep(r.canKeepVault);
      },
      (e) => setLink({ kind: "invalid", error: errorMessage(e) }),
    );
  }, []);

  const toSignIn = (
    <button
      type="button"
      className="w-full text-center text-muted-foreground text-sm hover:text-foreground"
      onClick={() => window.location.assign("/login")}
    >
      I remembered it, back to sign in
    </button>
  );

  if (link.kind === "checking") return <AuthLayout title="Checking your link…">{null}</AuthLayout>;

  if (link.kind === "invalid")
    return (
      <AuthLayout title="This link can't be used" subtitle={link.error}>
        <div className="space-y-4">
          <Button
            className="w-full"
            variant="outline"
            onClick={() => window.location.assign("/forgot-password")}
          >
            Request a new link
          </Button>
          {toSignIn}
        </div>
      </AuthLayout>
    );

  return (
    <NewPasswordForm
      subtitle={`For ${link.email}. Other devices are signed out.`}
      twoFactorRequired={link.twoFactorRequired}
      ready={keep || understood}
      submitLabel={keep ? "Set new master password" : "Start fresh"}
      busyLabel={keep ? "Opening your vault on this device…" : "Setting up your new vault…"}
      onSubmit={async (password, code) => {
        if (keep) await resetPassword({ token: link.token, password, code });
        else await startOver({ token: link.token, password, code });
        // No reload: the vault key lives only in this page's memory.
        onDone();
      }}
      footer={toSignIn}
    >
      <div role="radiogroup" aria-label="What happens to your vault" className="space-y-2">
        {link.canKeepVault ? (
          <ResetChoice selected={keep} onSelect={() => setKeep(true)} title="Keep my vault">
            Items, workspaces and shares stay as they are. Only the master password changes.
          </ResetChoice>
        ) : (
          <p className="rounded-lg border px-3 py-2.5 text-muted-foreground text-xs">
            Email reset was off for this account, so this link can't keep your vault. To keep it,
            use a backup code from the sign-in page instead.
          </p>
        )}
        <ResetChoice selected={!keep} onSelect={() => setKeep(false)} title="Start fresh">
          A new, empty vault. Your old vault is deleted and you leave your workspaces.
        </ResetChoice>
      </div>
      {!keep && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          <span>I understand my old vault will be deleted and can't be recovered.</span>
        </label>
      )}
    </NewPasswordForm>
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
