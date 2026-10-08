import {
  aad,
  deriveMasterKeys,
  estimateStrength,
  newKdfParams,
  unwrapKey,
  type VaultKeys,
  wipe,
  wrapKey,
} from "@minions/core";
import {
  type PublicKeyCredentialCreationOptionsJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import {
  Download,
  Fingerprint,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Upload,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { PasswordInput, StrengthBar } from "@/components/auth/auth-screens";
import { Page, PageBody, Section } from "@/components/layout/page";
import { SimpleSelect } from "@/components/simple-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage, get, patch, post } from "@/lib/api";
import {
  type MinionsBackup,
  parseBackup,
  type RestoreSummary,
  restoreBackup,
} from "@/lib/backup-restore";
import { useInvalidateVault } from "@/lib/queries";
import { rotateVaultKey, useSession } from "@/lib/session";
import { type Theme, useTheme } from "@/lib/theme";
import { toast } from "@/lib/toast";

/** Derives the auth key from the master password, to prove it to the server. */
async function proveMasterPassword(password: string): Promise<string> {
  const { kdf } = await get<Pick<VaultKeys, "kdf">>("/vault/kdf");
  const { authKey, stretchedKey } = await deriveMasterKeys(password, kdf);
  wipe(stretchedKey);
  return authKey;
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-border/60 border-b py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="font-medium text-sm">{label}</div>
        {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
      <p className="text-sm">
        Save these recovery codes somewhere safe outside Minions. Each works once if you lose your
        authenticator. They won't be shown again.
      </p>
      <div className="grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigator.clipboard.writeText(codes.join("\n")).then(() => toast.success("Copied"))
          }
        >
          Copy
        </Button>
        <Button size="sm" onClick={onDone}>
          I've saved them
        </Button>
      </div>
    </div>
  );
}

function TwoFactorSection() {
  const me = useSession((s) => s.me);
  const refresh = useSession((s) => s.refresh);
  const enabled = me?.user.twoFactorEnabled;
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"idle" | "disable" | "regenerate">("idle");
  const remaining = useQuery({
    queryKey: ["recovery-remaining"],
    enabled: !!enabled,
    queryFn: () => get<{ remaining: number }>("/auth/2fa/recovery-codes/remaining"),
  });

  const start = useMutation({
    mutationFn: () => post<{ secret: string; uri: string }>("/auth/2fa/setup"),
    onSuccess: async (r) =>
      setSetup({ ...r, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 180 }) }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const enable = useMutation({
    mutationFn: async () =>
      post<{ recoveryCodes: string[] }>("/auth/2fa/enable", {
        authKey: await proveMasterPassword(password),
        code,
      }),
    onSuccess: async (r) => {
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode("");
      setPassword("");
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const disable = useMutation({
    mutationFn: async () =>
      post("/auth/2fa/disable", { authKey: await proveMasterPassword(password), code }),
    onSuccess: async () => {
      toast.success("Two-factor authentication is off");
      setMode("idle");
      setCode("");
      setPassword("");
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const regenerate = useMutation({
    mutationFn: async () =>
      post<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", {
        authKey: await proveMasterPassword(password),
      }),
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      setMode("idle");
      setPassword("");
      void remaining.refetch();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Section
      title="Two-factor authentication"
      hint="A code from your authenticator app at every sign-in, on top of your master password."
    >
      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
      <Row
        label="Status"
        hint={enabled ? `${remaining.data?.remaining ?? "…"} recovery codes left` : "Off"}
      >
        {enabled ? (
          <div className="flex gap-1.5">
            <Badge variant="success">
              <ShieldCheck className="size-3" /> On
            </Badge>
            <Button size="xs" variant="outline" onClick={() => setMode("regenerate")}>
              New recovery codes
            </Button>
            <Button size="xs" variant="destructive-outline" onClick={() => setMode("disable")}>
              Turn off
            </Button>
          </div>
        ) : (
          !setup && (
            <Button size="sm" onClick={() => start.mutate()} loading={start.isPending}>
              Set up
            </Button>
          )
        )}
      </Row>
      {setup && (
        <div className="flex flex-col gap-4 sm:flex-row">
          <img
            src={setup.qr}
            alt="QR code for your authenticator app"
            className="size-44 rounded-lg border bg-white p-1"
          />
          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-sm">Scan with your authenticator app, or enter this key:</p>
            <code className="secret-text block rounded-md bg-muted px-2 py-1 text-xs">
              {setup.secret.match(/.{1,4}/g)?.join(" ")}
            </code>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="6-digit code"
                inputMode="numeric"
                autoComplete="one-time-code"
              />
              <PasswordInput
                id="2fa-pw"
                value={password}
                onChange={setPassword}
                placeholder="Master password"
                autoComplete="current-password"
              />
            </div>
            <Button
              size="sm"
              onClick={() => enable.mutate()}
              loading={enable.isPending}
              disabled={code.length !== 6 || !password}
            >
              Turn on
            </Button>
          </div>
        </div>
      )}
      {mode !== "idle" && (
        <div className="grid gap-2 sm:grid-cols-3">
          {mode === "disable" && (
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Code or recovery code"
            />
          )}
          <PasswordInput
            id="2fa-confirm"
            value={password}
            onChange={setPassword}
            placeholder="Master password"
            autoComplete="current-password"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant={mode === "disable" ? "destructive" : "default"}
              loading={disable.isPending || regenerate.isPending}
              disabled={!password || (mode === "disable" && code.length < 6)}
              onClick={() => (mode === "disable" ? disable.mutate() : regenerate.mutate())}
            >
              {mode === "disable" ? "Turn off 2FA" : "Generate"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

interface PasskeyRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function PasskeysSection() {
  const refresh = useSession((s) => s.refresh);
  const list = useQuery({
    queryKey: ["passkeys"],
    queryFn: () => get<PasskeyRow[]>("/auth/passkeys"),
  });
  const [mode, setMode] = useState<
    null | { kind: "add" } | { kind: "remove"; id: string; name: string }
  >(null);
  const [password, setPassword] = useState("");
  const [name, setName] = useState(() => {
    const ua = navigator.userAgent;
    return /Windows/.test(ua)
      ? "Windows Hello"
      : /Mac/.test(ua)
        ? "This Mac"
        : /Android/.test(ua)
          ? "Android phone"
          : /iPhone/.test(ua)
            ? "iPhone"
            : "Passkey";
  });
  const done = async (msg: string) => {
    toast.success(msg);
    setMode(null);
    setPassword("");
    await list.refetch();
    await refresh();
  };
  const add = useMutation({
    mutationFn: async () => {
      const optionsJSON = await post<PublicKeyCredentialCreationOptionsJSON>(
        "/auth/passkeys/register/options",
        { authKey: await proveMasterPassword(password) },
      );
      const response = await startRegistration({ optionsJSON });
      await post("/auth/passkeys/register", { response, name });
    },
    onSuccess: () => done("Passkey added. You can use it instead of a code when you sign in."),
    onError: (e) =>
      toast.error(
        e instanceof Error && e.name === "NotAllowedError"
          ? "Passkey prompt was cancelled"
          : errorMessage(e),
      ),
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      post(`/auth/passkeys/${id}/remove`, { authKey: await proveMasterPassword(password) }),
    onSuccess: () => done("Passkey removed"),
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Section
      title="Passkeys"
      hint="Sign in with Windows Hello, Touch ID, your phone or a security key instead of a 6-digit code. Your master password still opens the vault."
    >
      {list.data?.length === 0 && <p className="text-muted-foreground text-sm">No passkeys yet.</p>}
      {list.data?.map((p) => (
        <Row
          key={p.id}
          label={p.name}
          hint={`Added ${new Date(p.createdAt).toLocaleDateString()}${p.lastUsedAt ? ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : " · not used yet"}`}
        >
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={() => setMode({ kind: "remove", id: p.id, name: p.name })}
          >
            Remove
          </Button>
        </Row>
      ))}
      {mode ? (
        <div className="grid gap-2 sm:grid-cols-3">
          {mode.kind === "add" && (
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name, e.g. Windows Hello"
              maxLength={60}
            />
          )}
          <PasswordInput
            id="passkey-pw"
            value={password}
            onChange={setPassword}
            placeholder="Master password"
            autoComplete="current-password"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant={mode.kind === "remove" ? "destructive" : "default"}
              disabled={!password || (mode.kind === "add" && !name.trim())}
              loading={add.isPending || remove.isPending}
              onClick={() => (mode.kind === "add" ? add.mutate() : remove.mutate(mode.id))}
            >
              {mode.kind === "add" ? "Continue" : `Remove ${mode.name}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => setMode({ kind: "add" })}
        >
          <Fingerprint /> Add a passkey
        </Button>
      )}
    </Section>
  );
}

function RestoreBackup() {
  const fileRef = useRef<HTMLInputElement>(null);
  const invalidate = useInvalidateVault();
  const [backup, setBackup] = useState<MinionsBackup | null>(null);
  const [password, setPassword] = useState("");
  const [includeTrash, setIncludeTrash] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<RestoreSummary | null>(null);

  async function pick(file: File) {
    setResult(null);
    try {
      setBackup(parseBackup(await file.text()));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't read that file");
    }
  }

  async function run() {
    if (!backup) return;
    setProgress({ done: 0, total: backup.items.length + backup.notes.length });
    try {
      const summary = await restoreBackup(backup, password, {
        includeTrash,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult(summary);
      setBackup(null);
      setPassword("");
      await invalidate();
      toast.success("Backup restored");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : errorMessage(e));
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="space-y-3 border-border/60 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileRef.current?.click()}
          disabled={!!progress}
        >
          <Upload /> Restore from a backup…
        </Button>
        <span className="text-muted-foreground text-xs">
          Items already in your vault are skipped, so restoring twice is safe.
        </span>
      </div>
      {backup && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <p className="text-sm">
            Backup from {new Date(backup.exportedAt).toLocaleString()}:{" "}
            {backup.items.filter((i) => !i.deletedAt).length} items,{" "}
            {backup.notes.filter((n) => !n.deletedAt).length} notes
            {backup.items.some((i) => i.deletedAt)
              ? ` (+${backup.items.filter((i) => i.deletedAt).length} in trash)`
              : ""}
            .
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <PasswordInput
              id="restore-pw"
              value={password}
              onChange={setPassword}
              placeholder="Master password used for this backup"
              autoComplete="off"
            />
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={includeTrash} onCheckedChange={setIncludeTrash} /> Include items from
              the trash
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void run()} disabled={!password} loading={!!progress}>
              Decrypt & restore
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setBackup(null)} disabled={!!progress}>
              Cancel
            </Button>
            {progress && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {progress.done} / {progress.total}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            Decrypted on this device and encrypted again under your current vault. Version history
            is not restored.
          </p>
        </div>
      )}
      {result && (
        <p className="rounded-lg bg-emerald-500/8 px-3 py-2 text-emerald-700 text-sm dark:text-emerald-400">
          Restored {result.restoredItems} items and {result.restoredNotes} notes. Skipped{" "}
          {result.skippedItems + result.skippedNotes} already in your vault
          {result.failed ? `; ${result.failed} could not be restored` : ""}.
        </p>
      )}
    </div>
  );
}

function MasterPasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const change = useMutation({
    mutationFn: async () => {
      // Re-wraps the same user key under the new password. Vault data is not
      // re-encrypted and nothing secret is sent.
      const keys = await get<VaultKeys>("/vault/keys");
      const cur = await deriveMasterKeys(current, keys.kdf);
      const userKey = await unwrapKey(
        cur.stretchedKey,
        keys.protectedUserKey,
        aad.userKey(keys.userId),
      );
      const kdf = newKdfParams();
      const fresh = await deriveMasterKeys(next, kdf);
      const protectedUserKey = await wrapKey(fresh.stretchedKey, userKey, aad.userKey(keys.userId));
      wipe(userKey);
      wipe(cur.stretchedKey);
      wipe(fresh.stretchedKey);
      await post("/auth/change-password", {
        currentAuthKey: cur.authKey,
        newAuthKey: fresh.authKey,
        kdf,
        protectedUserKey,
      });
    },
    onSuccess: () => {
      toast.success("Master password changed", "Other devices were signed out.");
      setCurrent("");
      setNext("");
      setConfirm("");
    },
    onError: (e) =>
      toast.error(
        e instanceof Error && e.name === "DecryptionError"
          ? "Current master password is incorrect"
          : errorMessage(e),
      ),
  });
  const ok = current && next.length >= 12 && estimateStrength(next).score >= 3 && next === confirm;
  return (
    <Section
      title="Master password"
      hint="Changing it signs out every other device. It cannot be recovered if forgotten."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="mp-current">Current</Label>
          <PasswordInput
            id="mp-current"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mp-new">New</Label>
          <PasswordInput id="mp-new" value={next} onChange={setNext} autoComplete="new-password" />
          <StrengthBar password={next} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mp-confirm">Confirm new</Label>
          <PasswordInput
            id="mp-confirm"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
          />
        </div>
      </div>
      <Button
        size="sm"
        className="self-start"
        disabled={!ok}
        loading={change.isPending}
        onClick={() => change.mutate()}
      >
        <KeyRound /> Change master password
      </Button>
    </Section>
  );
}

function VaultKeySection() {
  const [password, setPassword] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const invalidate = useInvalidateVault();
  const rotate = useMutation({
    mutationFn: () => rotateVaultKey(password, setProgress),
    onSuccess: () => {
      toast.success("Vault key changed", "Other devices must unlock again.");
      setPassword("");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : errorMessage(e)),
    onSettled: () => setProgress(null),
  });
  return (
    <Section
      title="Vault key"
      hint="Re-encrypts everything in your vault under a new key, on this device. Do this if a device that had your vault unlocked was lost or compromised: changing the master password alone keeps the same key."
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="space-y-1.5 sm:w-72">
          <Label htmlFor="vk-password">Master password</Label>
          <PasswordInput
            id="vk-password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!password || rotate.isPending}
          loading={rotate.isPending}
          onClick={() => rotate.mutate()}
        >
          <RefreshCw /> Change vault key
        </Button>
        {progress && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {progress.done} / {progress.total}
          </span>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Keep this tab open until it finishes. If it is interrupted, it resumes the next time you
        unlock. Backups exported before the change still open with the master password they were
        made with.
      </p>
    </Section>
  );
}

const TAB_TITLES = {
  account: "Account",
  security: "Sign-in & keys",
  data: "Backup & recovery",
} as const;

export function SettingsPage() {
  const { tab = "account" } = useSearch({ strict: false }) as { tab?: "security" | "data" };
  const me = useSession((s) => s.me);
  const setSettings = useSession((s) => s.setSettings);
  const emergencyLock = useSession((s) => s.emergencyLock);
  const [theme, setTheme] = useTheme();
  const [name, setName] = useState(me?.user.name ?? "");
  const ai = useQuery({
    queryKey: ["ai-status"],
    queryFn: () => get<{ available: boolean }>("/ai/status"),
  });

  useEffect(() => setName(me?.user.name ?? ""), [me?.user.name]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      patch<{
        name: string;
        autoLockMinutes: number;
        clipboardClearSeconds: number;
        aiEnabled: boolean;
      }>("/users/me/settings", body),
    onSuccess: (s) => {
      setSettings(s);
      toast.success("Saved");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const backup = useMutation({
    mutationFn: () => get<unknown>("/vault/export"),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `minions-encrypted-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("Encrypted backup downloaded", "Only your master password can open it.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!me) return null;
  return (
    <Page title={TAB_TITLES[tab]} crumbs={[{ label: "Settings", to: "/settings" }]}>
      <PageBody title={TAB_TITLES[tab]} className="max-w-3xl">
        {tab === "account" && (
          <>
            <Section title="Account">
              <Row label="Name">
                <div className="flex gap-1.5">
                  <Input value={name} onChange={(e) => setName(e.target.value)} className="w-56" />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!name.trim() || name === me.user.name}
                    onClick={() => save.mutate({ name })}
                  >
                    Save
                  </Button>
                </div>
              </Row>
              <Row label="Email" hint="Used to sign in">
                <span className="text-sm">{me.user.email}</span>
              </Row>
            </Section>

            <Section title="Vault">
              <Row
                label="Auto-lock"
                hint="Lock the vault after this much inactivity. The extension and desktop app lock on their own too."
              >
                <SimpleSelect
                  className="w-44"
                  value={String(me.user.autoLockMinutes)}
                  onChange={(v) => save.mutate({ autoLockMinutes: Number(v) })}
                  options={[
                    { value: "0", label: "Immediately" },
                    { value: "1", label: "1 minute" },
                    { value: "5", label: "5 minutes" },
                    { value: "15", label: "15 minutes" },
                    { value: "30", label: "30 minutes" },
                    { value: "60", label: "1 hour" },
                    { value: "240", label: "4 hours" },
                  ]}
                />
              </Row>
              <Row label="Clear clipboard" hint="After copying a password or secret">
                <SimpleSelect
                  className="w-44"
                  value={String(me.user.clipboardClearSeconds)}
                  onChange={(v) => save.mutate({ clipboardClearSeconds: Number(v) })}
                  options={[
                    { value: "15", label: "After 15 seconds" },
                    { value: "30", label: "After 30 seconds" },
                    { value: "60", label: "After 60 seconds" },
                  ]}
                />
              </Row>
              <Row
                label="AI organisation"
                hint={
                  ai.data?.available
                    ? "DeepSeek suggests projects, collections and tags from names and websites only. Secrets and financial items are never sent."
                    : "Not configured on this server. Rules and your own habits are used instead."
                }
              >
                <Switch
                  checked={me.user.aiEnabled}
                  onCheckedChange={(v) => save.mutate({ aiEnabled: v })}
                />
              </Row>
              <Row label="Theme">
                <SimpleSelect
                  className="w-44"
                  value={theme}
                  onChange={(v) => setTheme(v as Theme)}
                  options={[
                    { value: "system", label: "System" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                />
              </Row>
            </Section>
          </>
        )}

        {tab === "security" && (
          <>
            <TwoFactorSection />
            <PasskeysSection />
            <MasterPasswordSection />
            <VaultKeySection />
          </>
        )}

        {tab === "data" && (
          <>
            <Section
              title="Backup"
              hint="Everything stays encrypted: values, history and notes. Restoring needs your master password."
            >
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() => backup.mutate()}
                loading={backup.isPending}
              >
                <Download /> Download encrypted backup
              </Button>
              <RestoreBackup />
            </Section>

            <Section title="Emergency" hint="Lost a device? Sign out everywhere at once.">
              <Button
                size="sm"
                variant="destructive"
                className="self-start"
                onClick={async () => {
                  if (window.confirm("Sign out every device, including this one?")) {
                    try {
                      await emergencyLock();
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }
                }}
              >
                <ShieldAlert /> Lock all devices
              </Button>
            </Section>
          </>
        )}
      </PageBody>
    </Page>
  );
}
