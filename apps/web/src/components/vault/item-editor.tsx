import {
  type AiClassifyResponse,
  CATEGORY_LABELS,
  CUSTOM_FIELD_PREFIX,
  cardBrand,
  confidenceBand,
  DYNAMIC_FIELD_PREFIX,
  type FieldDef,
  getItemType,
  ITEM_TYPES,
  type ItemCategory,
  isValidTotp,
  luhnValid,
  normalizeHost,
  parseDotenv,
  type SmartFillResult,
  smartFill,
  type VaultItemDetail,
  type VaultItemSummary,
} from "@minions/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  FolderKanban,
  Layers,
  Link2,
  Plus,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Unlink,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PasswordInput } from "@/components/auth/auth-screens";
import { buildPrefill } from "@/components/quick-capture";
import { SimpleSelect } from "@/components/simple-select";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  type AccessDraft,
  NewItemAccess,
  saveNewWorkspaceItem,
} from "@/components/workspaces/new-item-access";
import { ApiError, del, errorMessage, get, post, put } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fieldIcon } from "@/lib/field-icons";
import { ItemGlyph } from "@/lib/item-icons";
import { loadPersonalItem, loadSharedItem } from "@/lib/people-sharing";
import { useCollections, useInvalidateVault, useProjects } from "@/lib/queries";
import { toast } from "@/lib/toast";
import { type EditorRequest, useUi } from "@/lib/ui-store";
import { type CustomFieldInput, decryptAll, encryptDraft } from "@/lib/vault-crypto";
import { loadWorkspaceItem, newItemKey } from "@/lib/workspace-crypto";
import { useWorkspaceFolders } from "@/lib/workspace-queries";
import { ItemPicker } from "./item-picker";
import { PasswordGenerator } from "./password-generator";
import { SmartPaste } from "./smart-paste";
import { TotpCode } from "./totp-code";

function TypePicker({
  onPick,
  onPaste,
}: {
  onPick: (type: string) => void;
  onPaste: (r: SmartFillResult) => void;
}) {
  const categories = Object.keys(CATEGORY_LABELS) as ItemCategory[];
  return (
    <div className="space-y-4">
      <SmartPaste onFill={onPaste} />
      {categories.map((c) => (
        <div key={c}>
          <h3 className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {CATEGORY_LABELS[c]}
          </h3>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {ITEM_TYPES.filter((t) => t.category === c).map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => onPick(t.type)}
                className="flex items-center gap-2 rounded-lg border p-2 text-left text-sm transition-colors hover:bg-accent"
              >
                <ItemGlyph type={t.type} className="size-7 [&_svg]:size-3.5" />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatCardNumber(digits: string) {
  if (/^3[47]/.test(digits))
    return [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10, 15)]
      .filter(Boolean)
      .join(" ");
  return digits.replace(/(.{4})/g, "$1 ").trim();
}

function FieldInput({
  def,
  value,
  onChange,
  multi = false,
  onSmartPaste,
}: {
  def: FieldDef;
  value: string;
  onChange: (v: string) => void;
  /** New domain items: several at once, one per line. */
  multi?: boolean;
  /** Pasting several details into one field spreads them over the form. */
  onSmartPaste?: (text: string) => void;
}) {
  const id = `f-${def.key}`;
  if (multi) {
    return (
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={value.includes("\n") ? 4 : 1}
        className="font-mono text-[13px]"
        placeholder={"example.com\n(one per line to add several at once)"}
        spellCheck={false}
      />
    );
  }
  switch (def.kind) {
    case "password":
      return (
        <div className="flex gap-1.5">
          <div className="flex-1">
            <PasswordInput id={id} value={value} onChange={onChange} autoComplete="new-password" />
          </div>
          {def.generate !== false && (
            <Popover>
              <PopoverTrigger
                render={<Button variant="outline" size="icon" aria-label="Generate password" />}
              >
                <WandSparkles />
              </PopoverTrigger>
              <PopoverPopup className="w-80" align="end">
                <PasswordGenerator onUse={onChange} />
              </PopoverPopup>
            </Popover>
          )}
        </div>
      );
    case "secret":
    case "cvv":
      return <PasswordInput id={id} value={value} onChange={onChange} autoComplete="off" />;
    case "totp":
      return (
        <div className="space-y-1.5">
          <PasswordInput
            id={id}
            value={value}
            onChange={onChange}
            autoComplete="off"
            placeholder="JBSW Y3DP… or otpauth://totp/…"
          />
          {value &&
            (isValidTotp(value) ? (
              <TotpCode secret={value} compact />
            ) : (
              <p className="text-destructive-foreground text-xs">Not a valid TOTP secret</p>
            ))}
        </div>
      );
    case "multiline":
    case "code":
      return (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={def.kind === "code" ? 4 : 3}
          className={cn(def.kind === "code" && "font-mono text-xs")}
          spellCheck={def.kind !== "code"}
        />
      );
    case "select":
      return (
        <SimpleSelect
          id={id}
          value={value}
          onChange={onChange}
          options={(def.options ?? []).map((o) => ({ value: o, label: o }))}
          allowEmpty
          emptyLabel="—"
        />
      );
    case "boolean":
      return (
        <Switch
          id={id}
          checked={value === "true"}
          onCheckedChange={(c) => onChange(c ? "true" : "")}
        />
      );
    case "date":
      return <Input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
    case "number":
      return (
        <Input
          id={id}
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={def.placeholder}
        />
      );
    case "card-number": {
      const digits = value.replace(/\D/g, "");
      const brand = digits.length >= 4 ? cardBrand(digits) : null;
      const valid = digits.length >= 13 && luhnValid(digits);
      return (
        <div className="relative">
          <Input
            id={id}
            // Shown in groups of four (Amex 4-6-5); stored as digits.
            value={formatCardNumber(digits)}
            onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 19))}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              // More than a number (expiry, CVV, name…): fill the whole form.
              if (onSmartPaste && /[A-Za-z/|\n]/.test(text.trim())) {
                e.preventDefault();
                onSmartPaste(text);
              }
            }}
            inputMode="numeric"
            autoComplete="off"
            className="pe-28 font-mono tracking-wide"
            placeholder="Paste the whole card: number, expiry, CVV, name"
          />
          {brand && (
            <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-2.5 flex items-center gap-1.5 text-xs">
              <span className="rounded bg-muted px-1.5 py-0.5 font-semibold">{brand}</span>
              {digits.length >= 13 &&
                (valid ? (
                  <span className="text-emerald-600 dark:text-emerald-400">✓</span>
                ) : (
                  <span className="text-destructive-foreground">check number</span>
                ))}
            </span>
          )}
        </div>
      );
    }
    case "month":
      return (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 2))}
          inputMode="numeric"
          placeholder="MM"
        />
      );
    case "year":
      return (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          placeholder="YYYY"
        />
      );
    default:
      return (
        <Input
          id={id}
          type={def.kind === "email" ? "email" : def.kind === "url" ? "url" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={def.placeholder}
          autoComplete="off"
        />
      );
  }
}

interface Suggestion {
  data: NonNullable<AiClassifyResponse["classification"]>;
  id?: string;
}

function SuggestionBanner({
  suggestion,
  onAccept,
  onDismiss,
}: {
  suggestion: Suggestion;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const s = suggestion.data;
  const band = confidenceBand(s.confidence);
  const parts = [
    s.project && `Project: ${s.project}`,
    s.collection && `Collection: ${s.collection}`,
    s.tags.length && `Tags: ${s.tags.join(", ")}`,
  ].filter(Boolean);
  if (band === "low" || parts.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-xs">
        Couldn't confidently organise this item. Choose a project or collection below.
      </p>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-sm">
      <Sparkles className="mt-0.5 size-4 shrink-0 text-info-foreground" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          Suggested {Math.round(s.confidence * 100)}%
          {s.source === "ai" ? " · AI" : s.source === "preferences" ? " · from your habits" : ""}
        </div>
        <div className="text-muted-foreground text-xs">{parts.join(" · ")}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground/80">
          {s.reasons.slice(0, 2).join(". ")}
        </div>
      </div>
      <Button size="xs" onClick={onAccept}>
        Accept
      </Button>
      <Button size="xs" variant="ghost" onClick={onDismiss}>
        Change
      </Button>
    </div>
  );
}

function EditorForm({
  request,
  existing,
  plain,
}: {
  request: EditorRequest;
  existing?: VaultItemDetail;
  plain?: Record<string, string>;
}) {
  const closeEditor = useUi((s) => s.closeEditor);
  const invalidate = useInvalidateVault();
  const navigate = useNavigate();
  // In a workspace: its folders, no personal projects, links or AI suggestions.
  const ws = request.workspaceId;
  // Someone else's item shared with edit access: its fields only, never how the owner files it.
  const shared = !!request.shared;
  const { data: personalProjects } = useProjects();
  const { data: personalCollections } = useCollections();
  const { data: folders } = useWorkspaceFolders(ws);
  const projects = ws ? [] : personalProjects;
  const collections = ws ? folders : personalCollections;
  const [access, setAccess] = useState<AccessDraft>({ mode: "private", members: {} });
  const [type, setType] = useState(existing?.type ?? request.type ?? "");
  const def = getItemType(type);
  const [id, setId] = useState(existing?.id ?? crypto.randomUUID());
  const [name, setName] = useState(existing?.name ?? request.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...(plain ?? {}),
    ...(request.values ?? {}),
  }));
  const [custom, setCustom] = useState<CustomFieldInput[]>(() => [
    ...(existing?.fields
      .filter((f) => f.key.startsWith(CUSTOM_FIELD_PREFIX))
      .map((f) => ({
        key: f.key,
        label: f.label ?? f.key,
        sensitive: f.sensitive,
        kind: f.kind,
      })) ?? []),
    ...(request.custom ?? []),
  ]);
  const [projectId, setProjectId] = useState(existing?.project?.id ?? request.projectId ?? "");
  const [collectionId, setCollectionId] = useState(
    existing?.collection?.id ?? request.collectionId ?? "",
  );
  const [tags, setTags] = useState((existing?.tags ?? request.tags ?? []).join(", "));
  const [favorite, setFavorite] = useState(existing?.favorite ?? false);
  const [usedBy, setUsedBy] = useState<string[]>(existing?.usedBy.map((p) => p.id) ?? []);
  const [showAdvanced, setShowAdvanced] = useState(
    () => !!existing && def?.fields.some((f) => f.advanced && plain?.[f.key]),
  );
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [accepted, setAccepted] = useState<Suggestion | null>(null);
  const [saving, setSaving] = useState(false);
  const [envPaste, setEnvPaste] = useState("");
  const qc = useQueryClient();
  // A saved login this item signs in with, instead of a copy of its password.
  const existingLink = existing?.relations.find(
    (r) => r.kind === "USED_FOR" && r.direction === "incoming" && r.item.type === "LOGIN",
  );
  const [linked, setLinked] = useState<{
    id: string;
    name: string;
    subtitle: string | null;
    relationId?: string;
  } | null>(existingLink ? { ...existingLink.item, relationId: existingLink.id } : null);
  const [picking, setPicking] = useState(false);

  const set = (key: string, v: string) => setValues((s) => ({ ...s, [key]: v }));

  function applyPaste(r: SmartFillResult) {
    if (!type || r.type !== type) setType(r.type);
    setValues((s) => ({ ...s, ...r.values }));
    if (r.name && !name) setName(r.name);
    if (getItemType(r.type)?.fields.some((f) => f.advanced && r.values[f.key]))
      setShowAdvanced(true);
  }

  // A capture whose type was unclear: fill the fields once the user picks one.
  useEffect(() => {
    if (request.capture && !existing && type)
      setValues(buildPrefill(request.capture, type, request.capture.classification.provider));
  }, [type, request.capture, existing]);
  const isNew = !existing;
  const host = normalizeHost(
    values.url ?? values.base_url ?? values.console_url ?? values.endpoint ?? null,
  );
  const provider =
    values.provider ??
    values.issuer ??
    values.service ??
    values.software ??
    values.bank ??
    undefined;

  // Organising suggestions for new items: rules + habits first, AI only with
  // safe metadata and never for financial items (the server enforces both).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-suggest only when the identifying metadata changes
  useEffect(() => {
    if (ws || !isNew || !def || def.financial || (!name && !host && !provider)) return;
    const t = window.setTimeout(async () => {
      try {
        const res = await post<AiClassifyResponse>("/ai/classify", {
          name: name || undefined,
          host: host ?? undefined,
          provider,
          typeHint: type,
        });
        if (!res.classification) return;
        const s: Suggestion = { data: res.classification, id: res.id };
        if (confidenceBand(s.data.confidence) === "high" && !projectId && !collectionId) apply(s);
        else setSuggestion(s);
      } catch {
        /* suggestions are optional */
      }
    }, 700);
    return () => window.clearTimeout(t);
  }, [name, host, provider, type]);

  function apply(s: Suggestion) {
    const p = projects?.find((x) => x.name === s.data.project);
    const c = collections?.find((x) => x.name.toLowerCase() === s.data.collection?.toLowerCase());
    if (p) setProjectId(p.id);
    if (c) setCollectionId(c.id);
    if (s.data.tags.length)
      setTags((t) =>
        [
          ...new Set([
            ...t
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
            ...s.data.tags,
          ]),
        ].join(", "),
      );
    if (
      s.data.environment &&
      def?.fields.some((f) => f.key === "environment") &&
      !values.environment
    )
      set("environment", s.data.environment);
    setAccepted(s);
    setSuggestion(null);
  }

  const dynamicKeys = Object.keys(values).filter((k) => k.startsWith(DYNAMIC_FIELD_PREFIX));
  const canLink =
    !ws &&
    !shared &&
    !!def &&
    type !== "LOGIN" &&
    def.fields.some((f) => f.key === "password") &&
    def.fields.some((f) => f.key === "username");
  const LOGIN_KEYS = ["username", "email", "password", "url"];
  const hiddenByLink = (key: string) => !!linked && LOGIN_KEYS.includes(key);
  const accountHint = values.registrar || values.provider || values.bank || values.issuer || "";
  const { data: suggestions } = useQuery({
    queryKey: ["suggestions", type],
    enabled: !!def && !ws && !shared,
    staleTime: 60_000,
    queryFn: () =>
      get<Record<string, { value: string; count: number }[]>>("/vault/items/suggestions", { type }),
  });
  // "Use your Namecheap login?" when a saved login matches the registrar/provider.
  const { data: loginMatches } = useQuery({
    queryKey: ["login-match", accountHint],
    enabled: canLink && !linked && accountHint.trim().length > 1,
    queryFn: () =>
      get<{ items: VaultItemSummary[] }>("/vault/items", {
        q: accountHint,
        types: "LOGIN",
        limit: 3,
      }),
  });
  const visibleFields = useMemo(
    () => def?.fields.filter((f) => !f.advanced || showAdvanced) ?? [],
    [def, showAdvanced],
  );
  const hiddenCount =
    (def?.fields.filter((f) => f.advanced).length ?? 0) -
    (showAdvanced ? def!.fields.filter((f) => f.advanced).length : 0);

  async function save(another = false) {
    if (!def) return;
    setSaving(true);
    try {
      const domains =
        isNew && type === "DOMAIN"
          ? (values.domain ?? "")
              .split(/[\s,;]+/)
              .map((d) => d.trim().toLowerCase())
              .filter(Boolean)
          : [];
      if (domains.length > 1 && !ws) {
        await saveMany(domains);
        if (!another) return;
        resetForAnother();
        return;
      }
      const fieldValues = linked
        ? Object.fromEntries(Object.entries(values).filter(([k]) => !LOGIN_KEYS.includes(k)))
        : values;
      // A new workspace item gets its own key before anything is encrypted.
      if (ws && !existing) newItemKey(ws, id);
      const body = await encryptDraft(
        {
          id,
          type,
          name: name || values.provider || values.domain || host || def.label,
          description,
          projectId: projectId || null,
          collectionId: collectionId || null,
          favorite,
          tags: tags
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean),
          usedByProjectIds: usedBy,
          values: fieldValues,
          custom,
          revision: existing?.revision,
        },
        existing && plain ? { item: existing, plain } : undefined,
      );
      const saved = shared
        ? await put<VaultItemSummary>(`/shared/items/${id}`, body)
        : ws
          ? existing
            ? await put<VaultItemSummary>(`/workspaces/${ws}/items/${id}`, body)
            : await saveNewWorkspaceItem(ws, body, access)
          : existing
            ? await put<VaultItemSummary>(`/vault/items/${id}`, body)
            : await post<VaultItemSummary>("/vault/items", body);
      if (!ws && !shared) await syncLink(saved.id);
      // Teach the classifier what the user actually chose.
      const chosenProject = projects?.find((p) => p.id === projectId)?.name;
      const chosenCollection = collections?.find((c) => c.id === collectionId)?.name;
      if (isNew && (chosenProject || chosenCollection) && provider) {
        const s = accepted ?? suggestion;
        const outcome =
          s &&
          s.data.project === chosenProject &&
          (s.data.collection ?? "").toLowerCase() === (chosenCollection ?? "").toLowerCase()
            ? "accepted"
            : "corrected";
        void post("/ai/feedback", {
          classificationId: s?.id ?? request.classificationId,
          provider,
          host: host ?? undefined,
          type,
          project: chosenProject,
          collection: chosenCollection,
          outcome,
        }).catch(() => undefined);
      }
      await invalidate();
      toast.success(existing ? "Saved" : `${def.label} saved`);
      void qc.invalidateQueries({ queryKey: ["suggestions"] });
      if (another) {
        resetForAnother();
        return;
      }
      closeEditor();
      if (isNew && ws)
        void navigate({
          to: "/w/$workspaceId",
          params: { workspaceId: ws },
          search: { item: saved.id },
        });
      else if (isNew) void navigate({ to: "/vault", search: { item: saved.id } });
    } catch (e) {
      toast.error(
        errorMessage(e),
        e instanceof ApiError && e.code === "REVISION_CONFLICT"
          ? "Close and reopen the item to get the latest version."
          : undefined,
      );
    } finally {
      setSaving(false);
    }
  }

  /** Points the linked login at this item, or removes a link the user took away. */
  async function syncLink(itemId: string) {
    if (existingLink && existingLink.id !== linked?.relationId)
      await del(`/relations/${existingLink.id}`).catch(() => undefined);
    if (linked && !linked.relationId)
      await post("/relations", { fromItemId: linked.id, toItemId: itemId, kind: "USED_FOR" });
  }

  /** Several domains in one go: one item each, sharing everything else. */
  async function saveMany(domains: string[]) {
    const shared = linked
      ? Object.fromEntries(Object.entries(values).filter(([k]) => !LOGIN_KEYS.includes(k)))
      : values;
    let done = 0;
    for (const domain of domains) {
      const itemId = crypto.randomUUID();
      const body = await encryptDraft({
        id: itemId,
        type,
        name: domain,
        description,
        projectId: projectId || null,
        collectionId: collectionId || null,
        favorite,
        tags: tags
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
        usedByProjectIds: usedBy,
        values: { ...shared, domain },
        custom,
      });
      await post("/vault/items", body);
      if (linked)
        await post("/relations", { fromItemId: linked.id, toItemId: itemId, kind: "USED_FOR" });
      done++;
    }
    await invalidate();
    toast.success(`${done} domains saved`);
    if (done) closeEditor();
  }

  /** Keeps what the next item will share (registrar, login, project, tags) and clears the rest. */
  function resetForAnother() {
    const sticky = [
      "registrar",
      "url",
      "provider",
      "environment",
      "bank",
      "issuer",
      "engine",
      "region",
      "account_id",
    ];
    setValues((s) => Object.fromEntries(Object.entries(s).filter(([k]) => sticky.includes(k))));
    setName("");
    setDescription("");
    setId(crypto.randomUUID());
    setLinked((l) => (l ? { ...l, relationId: undefined } : l));
    window.setTimeout(
      () => document.getElementById(type === "DOMAIN" ? "f-domain" : "item-name")?.focus(),
      50,
    );
  }

  if (!def) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>New item</DialogTitle>
          <DialogDescription>What are you saving?</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <TypePicker onPick={setType} onPaste={applyPaste} />
        </DialogPanel>
      </>
    );
  }

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ItemGlyph type={type} className="size-7 [&_svg]:size-3.5" />
          {existing ? `Edit ${def.label.toLowerCase()}` : `New ${def.label.toLowerCase()}`}
        </DialogTitle>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <SmartPaste type={type} onFill={applyPaste} />
        {suggestion && (
          <SuggestionBanner
            suggestion={suggestion}
            onAccept={() => apply(suggestion)}
            onDismiss={() => setSuggestion(null)}
          />
        )}
        <div className="space-y-1.5">
          <Label htmlFor="item-name">Name</Label>
          <Input
            id="item-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={def.label}
            autoFocus={isNew}
            maxLength={200}
          />
        </div>

        {canLink && (
          <div className="rounded-xl border bg-muted/30 p-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="flex size-6 items-center justify-center rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400">
                <Link2 className="size-3.5" />
              </span>
              <span className="font-medium">Sign-in</span>
              {linked ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    Uses <span className="font-medium text-foreground">{linked.name}</span>
                    {linked.subtitle ? ` · ${linked.subtitle}` : ""}
                  </span>
                  <Button size="xs" variant="ghost" onClick={() => setLinked(null)}>
                    <Unlink /> Unlink
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-muted-foreground text-xs">
                    Same account for many items? Link one saved login instead of typing it again.
                  </span>
                  <Button size="xs" variant="outline" onClick={() => setPicking((p) => !p)}>
                    <Link2 /> Use a saved login
                  </Button>
                </>
              )}
            </div>
            {!linked && loginMatches?.items.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {loginMatches.items.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setLinked({ id: l.id, name: l.name, subtitle: l.subtitle })}
                    className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs hover:bg-accent"
                  >
                    <ItemGlyph type="LOGIN" className="size-4 rounded [&_svg]:size-2.5" />
                    Use {l.name}
                    {l.subtitle && <span className="text-muted-foreground">· {l.subtitle}</span>}
                  </button>
                ))}
              </div>
            ) : null}
            {picking && !linked && (
              <div className="mt-2">
                <ItemPicker
                  types="LOGIN"
                  initialQuery={accountHint}
                  placeholder="Search your logins…"
                  onPick={(l) => {
                    setLinked({ id: l.id, name: l.name, subtitle: l.subtitle });
                    setPicking(false);
                  }}
                />
              </div>
            )}
          </div>
        )}

        {visibleFields
          .filter((f) => !hiddenByLink(f.key))
          .map((f) => {
            const Icon = fieldIcon(f);
            const chips = (suggestions?.[f.key] ?? [])
              .filter((x) => x.value !== values[f.key])
              .slice(0, 4);
            const multi = isNew && !ws && type === "DOMAIN" && f.key === "domain";
            return (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`f-${f.key}`} className="flex items-center gap-1.5">
                  <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                  {f.label}
                  {f.sensitive && (
                    <Badge variant="outline" size="sm">
                      encrypted
                    </Badge>
                  )}
                </Label>
                <FieldInput
                  def={f}
                  value={values[f.key] ?? ""}
                  onChange={(v) => set(f.key, v)}
                  multi={multi}
                  onSmartPaste={(text) => applyPaste(smartFill(text, type))}
                />
                {chips.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {chips.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => set(f.key, c.value)}
                        className="max-w-full truncate rounded-md border border-border/80 px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
                        title={`Used on ${c.count} item${c.count === 1 ? "" : "s"}`}
                      >
                        {c.value}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

        {def.dynamicFields && (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label>Variables</Label>
              <span className="text-muted-foreground text-xs">{def.dynamicFields.hint}</span>
            </div>
            {dynamicKeys.map((k) => (
              <div key={k} className="flex items-center gap-1.5">
                <Input
                  value={k.slice(DYNAMIC_FIELD_PREFIX.length)}
                  readOnly
                  className="w-2/5 font-mono text-xs"
                />
                <div className="flex-1">
                  <PasswordInput id={k} value={values[k] ?? ""} onChange={(v) => set(k, v)} />
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove variable"
                  onClick={() =>
                    setValues((s) => {
                      const { [k]: _, ...rest } = s;
                      return rest;
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Textarea
              value={envPaste}
              onChange={(e) => setEnvPaste(e.target.value)}
              rows={3}
              placeholder={"DATABASE_URL=postgres://…\nOPENAI_API_KEY=sk-…"}
              className="font-mono text-xs"
            />
            <Button
              size="xs"
              variant="outline"
              disabled={!envPaste.trim()}
              onClick={() => {
                const pairs = parseDotenv(envPaste);
                setValues((s) => ({
                  ...s,
                  ...Object.fromEntries(
                    pairs.map((p) => [`${DYNAMIC_FIELD_PREFIX}${p.key}`, p.value]),
                  ),
                }));
                setEnvPaste("");
                toast.success(`${pairs.length} variable${pairs.length === 1 ? "" : "s"} added`);
              }}
            >
              <Plus /> Add variables
            </Button>
          </div>
        )}

        {custom.map((c) => (
          <div key={c.key} className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Input
                value={c.label}
                onChange={(e) =>
                  setCustom((cs) =>
                    cs.map((x) => (x.key === c.key ? { ...x, label: e.target.value } : x)),
                  )
                }
                className="h-7 flex-1 text-xs"
                aria-label="Field name"
              />
              <label className="flex items-center gap-1 text-muted-foreground text-xs">
                <Switch
                  checked={c.sensitive}
                  onCheckedChange={(v) =>
                    setCustom((cs) => cs.map((x) => (x.key === c.key ? { ...x, sensitive: v } : x)))
                  }
                />
                Encrypt
              </label>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Remove field"
                onClick={() => {
                  setCustom((cs) => cs.filter((x) => x.key !== c.key));
                  setValues((s) => {
                    const { [c.key]: _, ...rest } = s;
                    return rest;
                  });
                }}
              >
                <X />
              </Button>
            </div>
            {c.sensitive ? (
              <PasswordInput
                id={c.key}
                value={values[c.key] ?? ""}
                onChange={(v) => set(c.key, v)}
              />
            ) : (
              <Input value={values[c.key] ?? ""} onChange={(e) => set(c.key, e.target.value)} />
            )}
          </div>
        ))}

        <div className="flex flex-wrap gap-2">
          {hiddenCount > 0 && (
            <Button size="xs" variant="ghost" onClick={() => setShowAdvanced(true)}>
              <ChevronDown /> {hiddenCount} more field{hiddenCount === 1 ? "" : "s"}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              setCustom((cs) => [
                ...cs,
                {
                  key: `${CUSTOM_FIELD_PREFIX}${crypto.randomUUID().slice(0, 8)}`,
                  label: "Custom field",
                  sensitive: true,
                },
              ])
            }
          >
            <Plus /> Custom field
          </Button>
        </div>

        <div
          className={cn(
            "grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2",
            shared && "hidden",
          )}
        >
          <div className={cn("space-y-1.5", ws && "hidden")}>
            <Label className="flex items-center gap-1.5">
              <FolderKanban className="size-3.5 text-muted-foreground" aria-hidden /> Project
            </Label>
            <SimpleSelect
              value={projectId}
              onChange={setProjectId}
              allowEmpty
              options={(projects ?? [])
                .filter((p) => !p.archived)
                .map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>
          <div className={cn("space-y-1.5", ws && "sm:col-span-2")}>
            <Label className="flex items-center gap-1.5">
              <Layers className="size-3.5 text-muted-foreground" aria-hidden />{" "}
              {ws ? "Folder" : "Collection"}
            </Label>
            <SimpleSelect
              value={collectionId}
              onChange={setCollectionId}
              allowEmpty
              options={(collections ?? []).map((c) => ({ value: c.id, label: c.name }))}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="item-tags" className="flex items-center gap-1.5">
              <Tag className="size-3.5 text-muted-foreground" aria-hidden /> Tags
            </Label>
            <Input
              id="item-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="production, api"
            />
          </div>
          {(projects?.length ?? 0) > 0 &&
            (def.category === "secret" ||
              def.category === "infrastructure" ||
              type === "LOGIN") && (
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Also used by</Label>
                <div className="flex flex-wrap gap-1.5">
                  {projects!
                    .filter((p) => !p.archived && p.id !== projectId)
                    .map((p) => {
                      const on = usedBy.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() =>
                            setUsedBy((u) => (on ? u.filter((x) => x !== p.id) : [...u, p.id]))
                          }
                          className={cn(
                            "rounded-md border px-2 py-0.5 text-xs",
                            on
                              ? "border-primary bg-primary text-primary-foreground"
                              : "hover:bg-accent",
                          )}
                        >
                          {p.name}
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={favorite} onCheckedChange={setFavorite} />
            <Star
              className={cn(
                "size-3.5",
                favorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground",
              )}
              aria-hidden
            />{" "}
            Favorite
          </label>
        </div>

        {ws && isNew && <NewItemAccess workspaceId={ws} value={access} onChange={setAccess} />}

        <div className="space-y-1.5">
          <Label htmlFor="item-desc">Description</Label>
          <Textarea
            id="item-desc"
            value={description ?? ""}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Not encrypted: searchable. Put secrets in Notes."
          />
        </div>
      </DialogPanel>
      <DialogFooter>
        {isNew && !request.type && (
          <Button variant="ghost" className="sm:mr-auto" onClick={() => setType("")}>
            Change type
          </Button>
        )}
        <Button variant="ghost" onClick={closeEditor}>
          Cancel
        </Button>
        {isNew && (
          <Button
            variant="outline"
            loading={saving}
            onClick={() => void save(true)}
            title="Keeps registrar, login, project and tags for the next one"
          >
            <Plus /> Save & add another
          </Button>
        )}
        <Button type="submit" loading={saving}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The one editor for every item type, mounted once at the app root. */
export function ItemEditorDialog() {
  const request = useUi((s) => s.editor);
  const closeEditor = useUi((s) => s.closeEditor);
  const itemId = request?.itemId;
  const existing = useQuery({
    queryKey: ["item-edit", itemId],
    enabled: !!itemId,
    gcTime: 0,
    staleTime: 0,
    queryFn: async () => {
      const item = request?.workspaceId
        ? await loadWorkspaceItem(request.workspaceId, itemId!)
        : request?.shared
          ? await loadSharedItem(itemId!)
          : await loadPersonalItem(itemId!);
      return { item, plain: await decryptAll(item) };
    },
  });

  return (
    <Dialog open={!!request} onOpenChange={(o) => !o && closeEditor()}>
      <DialogPopup className="max-w-xl">
        {request && (!itemId || existing.data) ? (
          <EditorForm
            key={itemId ?? "new"}
            request={request}
            existing={existing.data?.item}
            plain={existing.data?.plain}
          />
        ) : (
          <DialogPanel className="py-10 text-center text-muted-foreground text-sm">
            {existing.error ? errorMessage(existing.error) : "Decrypting…"}
          </DialogPanel>
        )}
      </DialogPopup>
    </Dialog>
  );
}
