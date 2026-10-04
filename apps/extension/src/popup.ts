import { DEFAULT_PASSWORD_OPTIONS } from "@minions/core";
import {
  type ListedItem,
  type MatchResponse,
  type PendingSave,
  type StateResponse,
  send,
} from "./messages";

const app = document.getElementById("app")!;
const hostEl = document.getElementById("host")!;
const lockBtn = document.getElementById("lock") as HTMLButtonElement;

/** Element builder. Text always goes through textContent, never innerHTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string | null | false)[]
) {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const c of children)
    if (c) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

function render(...nodes: Node[]) {
  app.replaceChildren(...nodes);
}

const GLYPH: Record<string, string> = {
  LOGIN: "🌐",
  API_KEY: "🔑",
  SECRET: "🔒",
  TOTP: "⏱",
  SERVER: "🖥",
  DATABASE: "🗄",
  CLOUD: "☁️",
  CREDIT_CARD: "💳",
};

let clipTimer: number | undefined;
async function copy(value: string, label: string) {
  await navigator.clipboard.writeText(value);
  // The background clears it even after this popup has closed.
  await send({ type: "clipboardWritten" }).catch(() => undefined);
  window.clearTimeout(clipTimer);
  clipTimer = window.setTimeout(
    () => void navigator.clipboard.writeText("").catch(() => undefined),
    30_000,
  );
  flash(`${label} copied · clears in 30s`);
}

function flash(text: string, error = false) {
  const el = h("p", { class: error ? "error" : "muted small" }, text);
  app.prepend(el);
  setTimeout(() => el.remove(), 3000);
}

async function act<T>(fn: () => Promise<T>, button?: HTMLButtonElement): Promise<T | undefined> {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    flash(e instanceof Error ? e.message : "Something went wrong", true);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

function signInView() {
  const email = h("input", {
    type: "email",
    autocomplete: "username",
    placeholder: "you@example.com",
  });
  const password = h("input", { type: "password", autocomplete: "current-password" });
  const button = h("button", { type: "submit" }, "Sign in");
  const form = h(
    "form",
    {},
    h("h2", {}, "Sign in to your vault"),
    h("label", {}, "Email", email),
    h("label", {}, "Master password", password),
    button,
  );
  form.style.cssText = "display:flex;flex-direction:column;gap:10px";
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    button.textContent = "Deriving keys…";
    await act(() => send({ type: "login", email: email.value, password: password.value }), button);
    button.textContent = "Sign in";
    await route();
  });
  render(form, h("p", { class: "muted small" }, "Your master password never leaves this browser."));
  email.focus();
}

function twoFactorView() {
  const code = h("input", { placeholder: "123456", autocomplete: "one-time-code" });
  const button = h("button", { type: "submit" }, "Verify");
  const form = h("form", {}, h("h2", {}, "Two-factor code"), code, button);
  form.style.cssText = "display:flex;flex-direction:column;gap:10px";
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await act(() => send({ type: "verify2fa", code: code.value }), button);
    await route();
  });
  render(form);
  code.focus();
}

function lockedView(state: StateResponse) {
  const password = h("input", { type: "password", autocomplete: "current-password" });
  const button = h("button", { type: "submit" }, "Unlock");
  const signOut = h("button", { type: "button", class: "ghost" }, "Sign out");
  signOut.addEventListener("click", async () => {
    await send({ type: "logout" });
    await route();
  });
  const form = h(
    "form",
    {},
    h("h2", {}, "Vault locked"),
    h("p", { class: "muted small" }, state.email ?? ""),
    h("label", {}, "Master password", password),
    button,
    signOut,
  );
  form.style.cssText = "display:flex;flex-direction:column;gap:10px";
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await act(() => send({ type: "unlock", password: password.value }), button);
    await route();
  });
  render(form);
  password.focus();
}

function itemRow(item: ListedItem, tabId: number | undefined, canFill: boolean) {
  const actions = h("div", { class: "actions" });
  if (canFill && tabId !== undefined) {
    const fill = h("button", {}, "Fill");
    fill.addEventListener("click", () =>
      act(async () => {
        await send({ type: "fill", tabId, itemId: item.id, workspaceId: item.workspaceId });
        window.close();
      }, fill),
    );
    actions.append(fill);
  }
  const user = h("button", { class: "ghost", title: "Copy username" }, "User");
  user.addEventListener("click", () =>
    act(async () =>
      copy(
        await send<string>({
          type: "copy",
          itemId: item.id,
          field: "username",
          workspaceId: item.workspaceId,
        }),
        "Username",
      ),
    ),
  );
  const pass = h("button", { class: "ghost", title: "Copy password" }, "Pass");
  pass.addEventListener("click", () =>
    act(async () =>
      copy(
        await send<string>({
          type: "copy",
          itemId: item.id,
          field: "password",
          workspaceId: item.workspaceId,
        }),
        "Password",
      ),
    ),
  );
  actions.append(user, pass);
  if (item.hasTotp) {
    const totp = h("button", { class: "ghost", title: "Copy 2FA code" }, "2FA");
    totp.addEventListener("click", () =>
      act(async () => {
        const r = await send<{ code: string; remaining: number }>({
          type: "totp",
          itemId: item.id,
          workspaceId: item.workspaceId,
        });
        await copy(r.code, `Code ${r.code.slice(0, 3)} ${r.code.slice(3)} (${r.remaining}s)`);
      }),
    );
    actions.append(totp);
  }
  return h(
    "div",
    { class: "item" },
    h("span", { class: "glyph" }, GLYPH[item.type] ?? "•"),
    h(
      "div",
      { class: "meta" },
      h(
        "div",
        { class: "name" },
        item.name,
        // Team logins say where they come from (textContent only, like everything here).
        item.workspaceName ? h("span", { class: "team" }, item.workspaceName) : null,
      ),
      h("div", { class: "sub" }, item.subtitle ?? item.host ?? ""),
    ),
    actions,
  );
}

async function pendingBanner(): Promise<Node | null> {
  const pending = await send<PendingSave | null>({ type: "pendingSave" }).catch(() => null);
  if (!pending) return null;
  const isUpdate = !!pending.updateItemId;
  const save = h("button", {}, isUpdate ? "Update" : "Save");
  const ignore = h("button", { class: "ghost" }, "Cancel");
  const never = h("button", { class: "ghost" }, "Never for this site");
  const banner = h(
    "div",
    { class: "banner" },
    h("strong", {}, isUpdate ? `Update ${pending.updateItemName}?` : "Save this login?"),
    h(
      "span",
      { class: "muted small" },
      `${pending.host}${pending.username ? ` · ${pending.username}` : ""}`,
    ),
    h("div", { class: "row" }, ignore, never, save),
  );
  save.addEventListener("click", () =>
    act(async () => {
      await send({ type: "resolveSave", id: pending.id, action: isUpdate ? "update" : "save" });
      banner.remove();
      flash("Saved to Minions");
    }, save),
  );
  never.addEventListener("click", () =>
    act(async () => {
      await send({ type: "resolveSave", id: pending.id, action: "never" });
      banner.remove();
    }),
  );
  ignore.addEventListener("click", () =>
    act(async () => {
      await send({ type: "resolveSave", id: pending.id, action: "ignore" });
      banner.remove();
    }),
  );
  return banner;
}

async function vaultView(state: StateResponse) {
  lockBtn.hidden = false;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const match =
    tab?.id !== undefined
      ? await send<MatchResponse>({ type: "match", tabId: tab.id }).catch(() => null)
      : null;
  hostEl.textContent = match?.host ?? "";

  const list = h("div", { class: "card" });
  const showItems = (items: ListedItem[], canFill: boolean, empty: string) => {
    list.replaceChildren(
      ...(items.length
        ? items.map((i) => itemRow(i, tab?.id, canFill))
        : [h("div", { class: "item muted small" }, empty)]),
    );
  };
  showItems(
    match?.items ?? [],
    true,
    match?.host ? `No logins saved for ${match.host}` : "Open a website to see its logins",
  );

  const search = h("input", { placeholder: "Search vault…" });
  let t: number | undefined;
  search.addEventListener("input", () => {
    window.clearTimeout(t);
    t = window.setTimeout(async () => {
      if (!search.value.trim()) return showItems(match?.items ?? [], true, "No matches");
      const items = await send<ListedItem[]>({
        type: "search",
        q: search.value.trim(),
      }).catch(() => []);
      // Fill is only offered where the item's site matches the page.
      showItems(items, false, "No matches");
    }, 200);
  });

  const generated = h("div", { class: "secret", hidden: true });
  const gen = h("button", { class: "outline" }, "Generate password");
  gen.addEventListener("click", () =>
    act(async () => {
      const pw = await send<string>({ type: "generate", options: DEFAULT_PASSWORD_OPTIONS });
      generated.textContent = pw;
      generated.hidden = false;
      await copy(pw, "Password");
    }),
  );

  const captureText = h("textarea", { placeholder: "Quick save: paste a key or describe it…" });
  const captureInfo = h("p", { class: "muted small" });
  const captureSave = h("button", { class: "outline", disabled: true }, "Save");
  captureText.addEventListener("input", async () => {
    if (!captureText.value.trim()) {
      captureInfo.textContent = "";
      captureSave.disabled = true;
      return;
    }
    const r = await send<{
      label: string;
      provider?: string;
      confidence: number;
      name: string;
      secrets: number;
    }>({ type: "capture", text: captureText.value });
    captureInfo.textContent = `${r.label}${r.provider ? ` · ${r.provider}` : ""} · ${Math.round(r.confidence * 100)}% · ${r.secrets ? "secret found, will be encrypted" : "no secret found"}`;
    captureSave.textContent = `Save as “${r.name}”`;
    captureSave.disabled = r.confidence < 0.6;
  });
  captureSave.addEventListener("click", () =>
    act(async () => {
      await send({ type: "saveCapture", text: captureText.value, name: "" });
      captureText.value = "";
      captureInfo.textContent = "Saved. Review it in the vault to add a project or tags.";
      captureSave.disabled = true;
    }, captureSave),
  );

  const open = h("button", { class: "ghost" }, "Open vault ↗");
  open.addEventListener("click", () => void chrome.tabs.create({ url: state.webUrl }));

  const banner = await pendingBanner();
  render(
    ...([
      banner,
      search,
      list,
      h("div", { class: "row" }, gen, open),
      generated,
      h("h2", {}, "Quick save"),
      captureText,
      captureInfo,
      captureSave,
    ].filter(Boolean) as Node[]),
  );
  search.focus();
}

async function route() {
  lockBtn.hidden = true;
  const state = await send<StateResponse>({ type: "state" });
  if (state.status === "signed-out") return signInView();
  if (state.status === "two-factor") return twoFactorView();
  if (state.status === "locked") return lockedView(state);
  return vaultView(state);
}

lockBtn.addEventListener("click", async () => {
  await send({ type: "lock" });
  await route();
});

void send({ type: "activity" }).catch(() => undefined);
void route();
