import {
  type AiClassifyResponse,
  analyzeCapture,
  type CaptureResult,
  confidenceBand,
  getItemType,
  type SecretMatch,
} from "@minions/core";
import { ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import { ItemGlyph } from "@/lib/item-icons";
import { useCollections, useProjects } from "@/lib/queries";
import { useUi } from "@/lib/ui-store";

// Which field a detected secret belongs in, per type.
const SECRET_FIELD: Record<string, string> = {
  LOGIN: "password",
  API_KEY: "api_key",
  SECRET: "secret",
  CLOUD: "secret_key",
  WEBHOOK: "secret",
  TOTP: "totp",
  SSH_KEY: "private_key",
  SERVER: "password",
  DATABASE: "connection_string",
  CREDIT_CARD: "number",
  BANK_ACCOUNT: "account_number",
  PAYMENT_ACCOUNT: "api_key",
  LICENSE: "license_key",
  RECOVERY_CODE: "codes",
  DOMAIN: "password",
  SECURE_NOTE: "content",
};

function pickSecret(type: string, secrets: SecretMatch[]): SecretMatch | undefined {
  const prefer: Record<string, SecretMatch["kind"][]> = {
    CREDIT_CARD: ["card"],
    TOTP: ["totp_uri", "high_entropy"],
    SSH_KEY: ["private_key"],
    DATABASE: ["connection_string"],
    BANK_ACCOUNT: ["iban"],
    LOGIN: ["password", "high_entropy"],
  };
  const order = prefer[type] ?? ["api_key", "token", "jwt", "high_entropy", "password"];
  for (const k of order) {
    const hit = secrets.find((s) => s.kind === k);
    if (hit) return hit;
  }
  return secrets[0];
}

function describe(s: SecretMatch) {
  const kind = s.kind === "high_entropy" ? "secret" : s.kind.replace("_", " ");
  return `${s.provider ? `${s.provider} ` : ""}${kind} · ${s.value.length} chars`;
}

export function buildPrefill(result: CaptureResult, type: string, provider?: string) {
  const values: Record<string, string> = {};
  const def = getItemType(type);
  const has = (k: string) => def?.fields.some((f) => f.key === k);
  const secret = pickSecret(type, result.secrets);
  const field = SECRET_FIELD[type];
  if (secret && field)
    values[field] = type === "CREDIT_CARD" ? secret.value.replace(/\D/g, "") : secret.value;
  if (result.url && has("url"))
    values.url = result.url.startsWith("http") ? result.url : `https://${result.url}`;
  if (result.email && has("email")) values.email = result.email;
  else if (result.email && has("username")) values.username = result.email;
  if (provider && has("provider")) values.provider = provider;
  if (provider && has("issuer")) values.issuer = provider;
  if (result.classification.environment && has("environment"))
    values.environment = result.classification.environment;
  if (type === "SECURE_NOTE" && !values.content) values.content = result.safeText;
  return values;
}

export function QuickCaptureDialog() {
  const open = useUi((s) => s.captureOpen);
  const setOpen = useUi((s) => s.setCapture);
  const openEditor = useUi((s) => s.openEditor);
  const { data: projects } = useProjects();
  const { data: collections } = useCollections();
  const [text, setText] = useState("");
  const [server, setServer] = useState<AiClassifyResponse | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!open) {
      setText("");
      setServer(null);
    }
  }, [open]);

  // Runs entirely on this device; the raw text is never sent anywhere.
  const result = useMemo(
    () =>
      text.trim()
        ? analyzeCapture(text, {
            projects: projects?.map((p) => p.name),
            collections: collections?.map((c) => c.name),
          })
        : null,
    [text, projects, collections],
  );

  // Learned preferences and (if allowed, not financial, still unsure) AI see
  // only the redacted text.
  useEffect(() => {
    setServer(null);
    if (!result || getItemType(result.classification.type)?.financial) return;
    const t = window.setTimeout(async () => {
      setAsking(true);
      try {
        setServer(
          await post<AiClassifyResponse>("/ai/classify", {
            text: result.safeText.slice(0, 500),
            host: result.host ?? undefined,
            provider: result.classification.provider,
          }),
        );
      } catch {
        setServer(null);
      } finally {
        setAsking(false);
      }
    }, 600);
    return () => window.clearTimeout(t);
  }, [result]);

  const best =
    server?.classification &&
    server.classification.confidence > (result?.classification.confidence ?? 0)
      ? server.classification
      : result?.classification;
  const band = best ? confidenceBand(best.confidence) : "low";
  const def = best ? getItemType(best.type) : undefined;

  function review() {
    if (!result || !best) return;
    const project = projects?.find((p) => p.name === best.project);
    const collection = collections?.find(
      (c) => c.name.toLowerCase() === best.collection?.toLowerCase(),
    );
    openEditor({
      type: best.type,
      name: result.suggestedName,
      values: buildPrefill(result, best.type, best.provider),
      projectId: band !== "low" ? (project?.id ?? null) : null,
      collectionId: band !== "low" ? (collection?.id ?? null) : null,
      tags: band !== "low" ? best.tags : [],
      classificationId: server?.id,
    });
    setText("");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> Quick capture
          </DialogTitle>
          <DialogDescription>
            Describe it, paste it, or both. Minions works out what it is. Nothing is saved until you
            confirm.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder={
              "Cloudflare production token for ClipMesh cf_…\nMy new YouTube login is me@gmail.com / …"
            }
            spellCheck={false}
            className="font-mono text-[13px]"
          />
          {result && best && (
            <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
              <div className="flex items-center gap-2.5">
                <ItemGlyph type={best.type} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{def?.label}</div>
                  <div className="text-muted-foreground text-xs">{result.suggestedName}</div>
                </div>
                <Badge
                  variant={band === "high" ? "success" : band === "medium" ? "warning" : "outline"}
                >
                  {Math.round(best.confidence * 100)}%{asking ? "…" : ""}
                </Badge>
              </div>
              <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-xs">
                {best.provider && (
                  <>
                    <dt className="text-muted-foreground">Provider</dt>
                    <dd>{best.provider}</dd>
                  </>
                )}
                {best.project && (
                  <>
                    <dt className="text-muted-foreground">Project</dt>
                    <dd>{best.project}</dd>
                  </>
                )}
                {best.environment && (
                  <>
                    <dt className="text-muted-foreground">Environment</dt>
                    <dd>{best.environment}</dd>
                  </>
                )}
                {best.collection && (
                  <>
                    <dt className="text-muted-foreground">Collection</dt>
                    <dd>{best.collection}</dd>
                  </>
                )}
                {result.email && (
                  <>
                    <dt className="text-muted-foreground">Account</dt>
                    <dd>{result.email}</dd>
                  </>
                )}
              </dl>
              {result.secrets.length > 0 && (
                <div className="flex items-start gap-1.5 rounded-lg bg-emerald-500/8 px-2.5 py-1.5 text-emerald-700 text-xs dark:text-emerald-400">
                  <ShieldCheck className="mt-px size-3.5 shrink-0" />
                  <span>
                    Found {result.secrets.map(describe).join(", ")}. It will be encrypted on this
                    device. Only the redacted text is used for suggestions.
                  </span>
                </div>
              )}
              {band === "low" && (
                <p className="text-muted-foreground text-xs">
                  Not sure what this is. You can pick the type in the next step.
                </p>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {band === "low" && result ? (
            <Button onClick={() => openEditor({ name: result.suggestedName, capture: result })}>
              Choose type
            </Button>
          ) : (
            <Button onClick={review} disabled={!result}>
              Review & save
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
