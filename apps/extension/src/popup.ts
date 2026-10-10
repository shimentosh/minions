import {
  DEFAULT_PASSWORD_OPTIONS,
  estimateStrength,
  generatePassword,
  type PasswordOptions,
} from "@minions/core";
import {
  type ItemView,
  type ListedItem,
  type MatchResponse,
  type PendingSave,
  type StateResponse,
  send,
  type TotpEntry,
} from "./messages";

const app = document.getElementById("app")!;
const hostEl = document.getElementById("host")!;
const lockBtn = document.getElementById("lock") as HTMLButtonElement;
const openBtn = document.getElementById("open-app") as HTMLButtonElement;
const tabsEl = document.getElementById("tabs")!;
const footer = document.getElementById("footer")!;
const toastEl = document.getElementById("toast")!;

// ─── Building blocks ─────────────────────────────────────────────────────────

/** Element builder. Text always goes through textContent, never innerHTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Omit<Partial<HTMLElementTagNameMap[K]>, "style"> & {
    class?: string;
    style?: string;
  } = {} as never,
  ...children: (Node | string | null | false | undefined)[]
) {
  const el = document.createElement(tag);
  const { class: cls, style, ...rest } = props;
  if (cls) el.className = cls;
  if (style) el.style.cssText = style;
  Object.assign(el, rest);
  for (const c of children)
    if (c) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

// Lucide icons (ISC). Fixed markup written here, never data.
const ICONS = {
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  external:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  timer:
    '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  logOut:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  logIn:
    '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
} as const;
type IconName = keyof typeof ICONS;

function icon(name: IconName, size = 16) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "i");
  svg.innerHTML = ICONS[name];
  return svg;
}

function iconButton(name: IconName, title: string, onClick: (b: HTMLButtonElement) => unknown) {
  const b = h("button", { type: "button", class: "icon", title }, icon(name));
  b.setAttribute("aria-label", title);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    void onClick(b);
  });
  return b;
}

const PALETTE = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
];
function colorFor(text: string) {
  let n = 0;
  for (const c of text) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[n % PALETTE.length]!;
}

/** The browser's own cached icon for a site: no network request, nothing leaves the device. */
const faviconUrl = (host: string) =>
  chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(`https://${host}`)}&size=32`);

function pixels(img: HTMLImageElement) {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  c.getContext("2d")?.drawImage(img, 0, 0, 16, 16);
  return c.toDataURL();
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** What Chrome returns for a site it has no icon for: a grey globe, worse than a letter. */
let defaultFavicon: Promise<string | null> | null = null;
function genericFavicon() {
  defaultFavicon ??= loadImage(faviconUrl("minions.invalid")).then((i) => (i ? pixels(i) : null));
  return defaultFavicon;
}

/** The site's icon when the browser has one, else a coloured letter. */
function avatar(name: string, host: string | null, size: "" | "lg" = "") {
  const el = h("div", { class: `avatar ${size}` }, (name.trim()[0] ?? "?").toUpperCase());
  el.style.background = colorFor(name);
  if (host)
    void Promise.all([loadImage(faviconUrl(host)), genericFavicon()]).then(([img, generic]) => {
      if (!img || pixels(img) === generic) return;
      img.alt = "";
      el.replaceChildren(img);
      el.classList.add("fav");
    });
  return el;
}

function initials(name: string | null, email: string | null) {
  const src = (name ?? email ?? "?").trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

let toastTimer: number | undefined;
function toast(text: string, error = false) {
  toastEl.textContent = text;
  toastEl.className = `show${error ? " error" : ""}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.className = ""), error ? 3500 : 2200);
}

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
  toast(`${label} copied · clears in 30s`);
}

async function act<T>(fn: () => Promise<T>, button?: HTMLButtonElement): Promise<T | undefined> {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e instanceof Error ? e.message : "Something went wrong", true);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

/** Timers of the current view, stopped when the view changes. */
let disposers: (() => void)[] = [];
function render(...nodes: (Node | null | false | undefined)[]) {
  for (const d of disposers) d();
  disposers = [];
  app.classList.remove("center");
  app.replaceChildren(...(nodes.filter(Boolean) as Node[]));
  app.scrollTop = 0;
}

function webHost(state: StateResponse) {
  try {
    return new URL(state.webUrl).host;
  } catch {
    return "Minions";
  }
}

const ref = (i: { id: string; workspaceId?: string; shared?: boolean }) => ({
  itemId: i.id,
  workspaceId: i.workspaceId,
  shared: i.shared,
});

// ─── Signed out, two-factor, locked ──────────────────────────────────────────

function connectButton(state: StateResponse, label: string) {
  const b = h("button", { type: "button", class: "lg block" }, icon("link"), label);
  b.addEventListener("click", () =>
    act(async () => {
      await send({ type: "connect" });
      waitingView(state);
    }, b),
  );
  return b;
}

function signInView(state: StateResponse) {
  const usePassword = h(
    "button",
    { type: "button", class: "ghost block" },
    "Use email and master password",
  );
  usePassword.addEventListener("click", () => passwordSignInView(state));
  render(
    h(
      "div",
      { class: "hero" },
      h("img", { src: "icon.png", alt: "", width: 56, height: 56 }),
      h("h1", {}, "Welcome to Minions"),
      h(
        "p",
        { class: "muted" },
        "Fill logins, see your 2FA codes and save new passwords, right from the browser.",
      ),
    ),
    h(
      "div",
      { class: "stack" },
      connectButton(state, "Sign in with Minions app"),
      h(
        "div",
        { class: "note" },
        icon("shield", 14),
        h(
          "span",
          {},
          `Opens ${webHost(state)}. Approve there and this extension stays connected: no password to type here.`,
        ),
      ),
      h("div", { class: "divider" }, "or"),
      usePassword,
    ),
  );
  app.classList.add("center");
}

function waitingView(state: StateResponse) {
  const back = h("button", { type: "button", class: "ghost" }, "Back");
  back.addEventListener("click", () => void route());
  const again = h(
    "button",
    { type: "button", class: "outline" },
    icon("external", 14),
    `Open ${webHost(state)}`,
  );
  again.addEventListener("click", () => void send({ type: "connect" }));
  render(
    h(
      "div",
      { class: "hero" },
      h("div", { class: "spinner" }),
      h("h1", {}, "Waiting for Minions"),
      h(
        "p",
        { class: "muted" },
        "Unlock Minions in the tab that opened and press Connect. This window updates on its own.",
      ),
    ),
    h("div", { class: "row", style: "justify-content:center" }, again, back),
  );
  app.classList.add("center");
  // The background tells an open popup when the app has connected it.
  const poll = window.setInterval(async () => {
    const s = await send<StateResponse>({ type: "state" }).catch(() => null);
    if (s && s.status !== "signed-out") void route();
  }, 1500);
  disposers.push(() => window.clearInterval(poll));
}

function passwordSignInView(state: StateResponse) {
  const email = h("input", {
    type: "email",
    autocomplete: "username",
    placeholder: "you@example.com",
  });
  const password = h("input", { type: "password", autocomplete: "current-password" });
  const button = h("button", { type: "submit", class: "block" }, "Sign in");
  const back = h("button", { type: "button", class: "ghost block" }, icon("back", 14), "Back");
  back.addEventListener("click", () => signInView(state));
  const form = h(
    "form",
    { class: "stack" },
    h("h1", {}, "Sign in with password"),
    h("label", {}, "Email", email),
    h("label", {}, "Master password", password),
    button,
    back,
  );
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
  const code = h("input", {
    class: "otp",
    placeholder: "000000",
    autocomplete: "one-time-code",
    inputMode: "numeric",
  });
  const button = h("button", { type: "submit", class: "block" }, "Verify");
  const cancel = h("button", { type: "button", class: "ghost block" }, "Cancel");
  cancel.addEventListener("click", async () => {
    await send({ type: "logout" }).catch(() => undefined);
    await route();
  });
  const form = h(
    "form",
    { class: "stack" },
    h(
      "div",
      { class: "hero" },
      h(
        "div",
        {
          class: "avatar lg round",
          style: "background:var(--muted-strong);color:var(--foreground)",
        },
        icon("shield", 22),
      ),
      h("h1", {}, "Two-factor code"),
      h(
        "p",
        { class: "muted small" },
        "Enter the code from your authenticator app, or a recovery code.",
      ),
    ),
    code,
    button,
    cancel,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await act(() => send({ type: "verify2fa", code: code.value.replace(/\s/g, "") }), button);
    await route();
  });
  render(form);
  app.classList.add("center");
  code.focus();
}

function lockedView(state: StateResponse) {
  const password = h("input", {
    type: "password",
    autocomplete: "current-password",
    placeholder: "Master password",
  });
  const unlock = h("button", { type: "submit", class: "outline" }, "Unlock");
  const signOut = h(
    "button",
    { type: "button", class: "ghost block" },
    icon("logOut", 14),
    "Sign out",
  );
  signOut.addEventListener("click", async () => {
    await send({ type: "logout" });
    await route();
  });
  const form = h("form", { class: "row" }, h("div", { class: "grow" }, password), unlock);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await act(() => send({ type: "unlock", password: password.value }), unlock);
    await route();
  });
  const who = h("div", { class: "avatar lg round" }, initials(state.name, state.email));
  who.style.background = colorFor(state.email ?? "?");
  render(
    h(
      "div",
      { class: "hero" },
      who,
      h("h1", {}, "Vault locked"),
      h("p", { class: "muted small" }, state.email ?? ""),
    ),
    h(
      "div",
      { class: "stack" },
      connectButton(state, "Unlock with Minions app"),
      h(
        "div",
        { class: "note" },
        icon("link", 14),
        h("span", {}, "Unlocks on its own whenever Minions is unlocked in this browser."),
      ),
      h("div", { class: "divider" }, "or"),
      form,
      signOut,
    ),
  );
  app.classList.add("center");
  // An app tab that is already unlocked reconnects this extension right away.
  void send({ type: "connect", silent: true }).catch(() => undefined);
  const poll = window.setInterval(async () => {
    const s = await send<StateResponse>({ type: "state" }).catch(() => null);
    if (s?.status === "unlocked") void route();
  }, 1000);
  disposers.push(() => window.clearInterval(poll));
}

// ─── Unlocked: tabs ──────────────────────────────────────────────────────────

type TabKey = "logins" | "totp" | "generator" | "add";
const TABS: { key: TabKey; label: string; icon: IconName }[] = [
  { key: "logins", label: "Logins", icon: "key" },
  { key: "totp", label: "2FA", icon: "timer" },
  { key: "generator", label: "Generate", icon: "sparkles" },
  { key: "add", label: "Add", icon: "plus" },
];

function savedTab(): TabKey {
  try {
    const t = localStorage.getItem("minions-tab");
    if (TABS.some((x) => x.key === t)) return t as TabKey;
  } catch {
    /* storage blocked */
  }
  return "logins";
}

let currentTab: TabKey = savedTab();
let activeTab: chrome.tabs.Tab | undefined;
let match: MatchResponse | null = null;

function drawTabs() {
  tabsEl.replaceChildren(
    ...TABS.map((t) => {
      const b = h("button", { type: "button" }, icon(t.icon, 14), t.label);
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(t.key === currentTab));
      b.addEventListener("click", () => {
        currentTab = t.key;
        try {
          localStorage.setItem("minions-tab", t.key);
        } catch {
          /* storage blocked */
        }
        drawTabs();
        showTab();
      });
      return b;
    }),
  );
}

function showTab() {
  if (currentTab === "totp") return void totpView();
  if (currentTab === "generator") return generatorView();
  if (currentTab === "add") return addView();
  return void loginsView();
}

// ─── Logins ──────────────────────────────────────────────────────────────────

function itemRow(item: ListedItem, canFill: boolean) {
  const actions = h("div", { class: "actions" });
  if (item.username)
    actions.append(
      iconButton("user", "Copy username", () =>
        act(async () =>
          copy(await send<string>({ type: "copy", field: "username", ...ref(item) }), "Username"),
        ),
      ),
    );
  // Logins (and anything else with a scored password) get a one-click copy.
  if (item.type === "LOGIN" || item.passwordStrength !== null)
    actions.append(
      iconButton("key", "Copy password", () =>
        act(async () =>
          copy(await send<string>({ type: "copy", field: "password", ...ref(item) }), "Password"),
        ),
      ),
    );
  if (item.hasTotp)
    actions.append(
      iconButton("timer", "Copy 2FA code", () =>
        act(async () => {
          const r = await send<{ code: string; remaining: number }>({ type: "totp", ...ref(item) });
          await copy(r.code, `2FA code (${r.remaining}s left)`);
        }),
      ),
    );
  if (canFill && activeTab?.id !== undefined) {
    const fill = h("button", { type: "button", class: "fill" }, "Fill");
    const tabId = activeTab.id;
    fill.addEventListener("click", (e) => {
      e.stopPropagation();
      void act(async () => {
        await send({ type: "fill", tabId, ...ref(item) });
        window.close();
      }, fill);
    });
    actions.append(fill);
  }
  const row = h(
    "div",
    { class: "item" },
    avatar(item.name, item.host),
    h(
      "div",
      { class: "meta" },
      h(
        "div",
        { class: "name" },
        h("span", {}, item.name),
        // Team and shared logins say where they come from.
        item.workspaceName
          ? h("span", { class: "badge" }, item.workspaceName)
          : item.sharedBy
            ? h("span", { class: "badge" }, `from ${item.sharedBy}`)
            : null,
      ),
      h("div", { class: "sub" }, item.username ?? item.subtitle ?? item.host ?? ""),
    ),
    actions,
  );
  row.addEventListener("click", () => void detailView(item));
  return row;
}

function list(items: ListedItem[], canFill: boolean) {
  return h("div", { class: "card" }, ...items.map((i) => itemRow(i, canFill)));
}

function section(title: string, ...children: Node[]) {
  return h("div", { class: "section" }, h("div", { class: "section-title" }, title), ...children);
}

let lastQuery = "";

async function loginsView() {
  const search = h("input", { placeholder: "Search your vault…", value: lastQuery });
  const results = h("div", { class: "stack" });
  const banner = await pendingBanner();

  const showHome = async () => {
    const parts: Node[] = [];
    if (match?.host) {
      parts.push(
        section(
          `On ${match.host}`,
          match.items.length
            ? list(match.items, true)
            : h(
                "div",
                { class: "card empty" },
                icon("globe", 20),
                h("span", {}, `No logins saved for ${match.host}.`),
                h("span", { class: "small" }, "Sign in on the page and Minions offers to save it."),
              ),
        ),
      );
    }
    results.replaceChildren(...parts);
    const [favorites, recent] = await Promise.all([
      send<ListedItem[]>({ type: "browse", view: "favorites" }).catch(() => []),
      send<ListedItem[]>({ type: "browse", view: "recent" }).catch(() => []),
    ]);
    if (search.value.trim()) return;
    const shown = new Set(match?.items.map((i) => i.id));
    const fav = favorites.filter((i) => !shown.has(i.id));
    for (const i of fav) shown.add(i.id);
    const rec = recent.filter((i) => !shown.has(i.id));
    if (fav.length) parts.push(section("Favorites", list(fav, false)));
    if (rec.length) parts.push(section("Recently used", list(rec, false)));
    if (!parts.length)
      parts.push(
        h(
          "div",
          { class: "card empty" },
          icon("search", 20),
          h("span", {}, "Search your vault, or star items in Minions to keep them here."),
        ),
      );
    results.replaceChildren(...parts);
  };

  let t: number | undefined;
  const runSearch = () => {
    window.clearTimeout(t);
    lastQuery = search.value;
    t = window.setTimeout(async () => {
      const q = search.value.trim();
      if (!q) return void showHome();
      const items = await send<ListedItem[]>({ type: "search", q }).catch(() => []);
      if (search.value.trim() !== q) return;
      // Fill is only offered where the item's site matches the page.
      const matched = new Set(match?.items.map((i) => i.id));
      results.replaceChildren(
        items.length
          ? section(
              `${items.length} result${items.length === 1 ? "" : "s"}`,
              h("div", { class: "card" }, ...items.map((i) => itemRow(i, matched.has(i.id)))),
            )
          : h("div", { class: "card empty" }, icon("search", 20), `Nothing matches “${q}”.`),
      );
    }, 180);
  };
  search.addEventListener("input", runSearch);

  render(banner, h("div", { class: "search" }, icon("search", 15), search), results);
  if (lastQuery.trim()) runSearch();
  else await showHome();
  search.focus();
}

async function pendingBanner(): Promise<Node | null> {
  const pending = await send<PendingSave | null>({ type: "pendingSave" }).catch(() => null);
  if (!pending) return null;
  const isUpdate = !!pending.updateItemId;
  const save = h("button", { type: "button" }, isUpdate ? "Update" : "Save");
  const ignore = h("button", { type: "button", class: "ghost" }, "Not now");
  const never = h("button", { type: "button", class: "ghost" }, "Never here");
  const banner = h(
    "div",
    { class: "banner" },
    h("strong", {}, isUpdate ? `Update ${pending.updateItemName}?` : "Save this login?"),
    h(
      "span",
      { class: "muted small" },
      `${pending.host}${pending.username ? ` · ${pending.username}` : ""}`,
    ),
    h("div", { class: "row" }, ignore, never, h("div", { class: "grow" }), save),
  );
  const resolve = (action: "save" | "update" | "ignore" | "never", b: HTMLButtonElement) =>
    act(async () => {
      await send({ type: "resolveSave", id: pending.id, action });
      banner.remove();
      if (action === "save" || action === "update") toast("Saved to Minions");
    }, b);
  save.addEventListener("click", () => resolve(isUpdate ? "update" : "save", save));
  never.addEventListener("click", () => resolve("never", never));
  ignore.addEventListener("click", () => resolve("ignore", ignore));
  return banner;
}

// ─── Item detail ─────────────────────────────────────────────────────────────

function ring(remaining: number, period: number) {
  const C = 2 * Math.PI * 10;
  const el = h("div", { class: "ring" });
  el.innerHTML =
    '<svg viewBox="0 0 26 26" width="26" height="26"><circle class="track" cx="13" cy="13" r="10"/><circle class="bar" cx="13" cy="13" r="10"/></svg>';
  const bar = el.querySelector<SVGCircleElement>(".bar")!;
  bar.style.strokeDasharray = String(C);
  const label = h("span");
  el.append(label);
  const set = (r: number, p: number) => {
    bar.style.strokeDashoffset = String(C * (1 - Math.max(r, 0) / p));
    label.textContent = String(Math.max(r, 0));
    el.classList.toggle("warn", r <= 10 && r > 5);
    el.classList.toggle("danger", r <= 5);
  };
  set(remaining, period);
  return { el, set };
}

function formatCode(code: string) {
  const mid = code.length === 8 ? 4 : 3;
  const el = h(
    "span",
    { class: "code" },
    code.slice(0, mid),
    h("span", { class: "gap" }),
    code.slice(mid),
  );
  return el;
}

async function detailView(listed: ListedItem) {
  const back = iconButton("back", "Back", () => showTab());
  render(h("div", { class: "row" }, back, h("span", { class: "muted small" }, "Loading…")));
  const item = await act(() =>
    send<ItemView>({ type: "item", ...ref(listed), tabId: activeTab?.id }),
  );
  if (!item) return showTab();

  const actions = h("div", { class: "row" });
  if (item.canFill && activeTab?.id !== undefined) {
    const tabId = activeTab.id;
    const fill = h(
      "button",
      { type: "button", class: "grow" },
      icon("logIn", 15),
      "Fill on this page",
    );
    fill.addEventListener("click", () =>
      act(async () => {
        await send({ type: "fill", tabId, ...ref(listed) });
        window.close();
      }, fill),
    );
    actions.append(fill);
  }
  if (item.url) {
    const url = item.url;
    const open = h(
      "button",
      { type: "button", class: "outline grow" },
      icon("external", 14),
      "Open site",
    );
    open.addEventListener("click", () => {
      try {
        const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
        if (u.protocol === "https:" || u.protocol === "http:")
          void chrome.tabs.create({ url: u.href });
      } catch {
        toast("That address is not a valid link", true);
      }
    });
    actions.append(open);
  }

  const fields = h("div", { class: "card" });
  if (item.hasTotp) {
    const codeBox = h("div", { class: "value" });
    const r = ring(30, 30);
    const row = h(
      "div",
      { class: "field" },
      h("div", { class: "meta" }, h("div", { class: "label" }, "Two-factor code"), codeBox),
      r.el,
      iconButton("copy", "Copy code", () =>
        act(async () => {
          const c = await send<{ code: string }>({ type: "totp", ...ref(listed) });
          await copy(c.code, "2FA code");
        }),
      ),
    );
    fields.append(row);
    let remaining = 0;
    let period = 30;
    const refresh = async () => {
      const c = await send<{ code: string; remaining: number; period: number }>({
        type: "totp",
        ...ref(listed),
        quiet: true,
      }).catch(() => null);
      if (!c) return;
      remaining = c.remaining;
      period = c.period;
      codeBox.replaceChildren(formatCode(c.code));
      r.set(remaining, period);
    };
    await refresh();
    const tick = window.setInterval(() => {
      remaining--;
      if (remaining <= 0) void refresh();
      else r.set(remaining, period);
      (codeBox.firstChild as HTMLElement | null)?.classList.toggle("expiring", remaining <= 5);
    }, 1000);
    disposers.push(() => window.clearInterval(tick));
  }

  for (const f of item.fields) {
    const value = h("div", {
      class: `value${f.sensitive ? " mono" : ""}${f.kind === "multiline" ? " wrap" : ""}`,
    });
    const buttons: Node[] = [];
    if (f.sensitive) {
      value.textContent = "••••••••••••";
      let shown = false;
      const eye = iconButton("eye", "Show", (b) =>
        act(async () => {
          if (shown) {
            value.textContent = "••••••••••••";
            b.replaceChildren(icon("eye"));
            b.title = "Show";
          } else {
            value.textContent = await send<string>({
              type: "reveal",
              field: f.key,
              ...ref(listed),
            });
            b.replaceChildren(icon("eyeOff"));
            b.title = "Hide";
          }
          shown = !shown;
        }),
      );
      buttons.push(eye);
    } else value.textContent = f.value ?? "";
    buttons.push(
      iconButton("copy", `Copy ${f.label.toLowerCase()}`, () =>
        act(async () =>
          copy(
            f.sensitive || f.value === null
              ? await send<string>({ type: "copy", field: f.key, ...ref(listed) })
              : f.value,
            f.label,
          ),
        ),
      ),
    );
    fields.append(
      h(
        "div",
        { class: "field" },
        h("div", { class: "meta" }, h("div", { class: "label" }, f.label), value),
        ...buttons,
      ),
    );
  }

  const where = listed.workspaceName ?? (listed.sharedBy ? `from ${listed.sharedBy}` : null);
  render(
    h("div", { class: "row" }, back, h("span", { class: "muted small" }, "Back")),
    h(
      "div",
      { class: "detail-head" },
      avatar(item.name, item.host, "lg"),
      h(
        "div",
        { class: "meta" },
        h("h1", {}, item.name),
        h(
          "div",
          { class: "muted small" },
          [item.typeLabel, item.host, where].filter(Boolean).join(" · "),
        ),
      ),
      item.favorite ? h("span", { class: "muted", title: "Favorite" }, icon("star", 15)) : null,
    ),
    actions.childElementCount ? actions : null,
    item.fields.length || item.hasTotp
      ? fields
      : h("div", { class: "card empty" }, "This item has no fields."),
  );
}

// ─── 2FA ─────────────────────────────────────────────────────────────────────

let totpQuery = "";

async function totpView() {
  const search = h("input", { placeholder: "Search 2FA codes…", value: totpQuery });
  const listEl = h("div", { class: "card" });
  render(
    h("div", { class: "search" }, icon("search", 15), search),
    h("div", { class: "card empty" }, h("div", { class: "spinner" })),
  );
  let entries = await send<TotpEntry[]>({ type: "totpList" }).catch((e: unknown) => {
    toast(e instanceof Error ? e.message : "Could not load 2FA codes", true);
    return [] as TotpEntry[];
  });

  if (!entries.length) {
    const open = h(
      "button",
      { type: "button", class: "outline" },
      icon("external", 14),
      "Open Authenticator",
    );
    open.addEventListener("click", async () => {
      const s = await send<StateResponse>({ type: "state" });
      void chrome.tabs.create({ url: new URL("/authenticator", s.webUrl).href });
    });
    render(
      h(
        "div",
        { class: "card empty" },
        icon("timer", 22),
        h("strong", {}, "No 2FA codes yet"),
        h(
          "span",
          {},
          "Add a 2FA secret to a login, or import QR codes in Minions → Authenticator.",
        ),
        open,
      ),
    );
    return;
  }

  type Row = {
    entry: TotpEntry;
    el: HTMLElement;
    set: (r: number, p: number) => void;
    code: HTMLElement;
    next: HTMLElement;
  };
  let rows: Row[] = [];

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    totpQuery = search.value;
    const shown = entries
      .filter((e) => !q || `${e.name} ${e.subtitle ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
    rows = shown.map((entry) => {
      const r = ring(entry.remaining, entry.period);
      const code = h("div", {});
      const next = h("div", { class: "next" });
      const el = h(
        "div",
        { class: "totp", title: "Click to copy" },
        avatar(entry.name, null),
        h(
          "div",
          { class: "meta" },
          h("div", { class: "name" }, entry.name),
          entry.subtitle ? h("div", { class: "sub" }, entry.subtitle) : null,
          code,
          next,
        ),
        r.el,
      );
      el.addEventListener("click", () =>
        act(async () => {
          if (!entry.code) throw new Error("This 2FA secret could not be read");
          // Fetched again, so the code copied is current and the use is recorded.
          const c = await send<{ code: string }>({ type: "totp", itemId: entry.id });
          await copy(c.code, `${entry.name} code`);
          const badge = h("span", { class: "copied" }, "Copied");
          el.append(badge);
          setTimeout(() => badge.remove(), 1200);
        }),
      );
      return { entry, el, set: r.set, code, next };
    });
    for (const row of rows) paint(row);
    listEl.replaceChildren(
      ...(rows.length
        ? rows.map((r) => r.el)
        : [h("div", { class: "empty" }, `Nothing matches “${search.value.trim()}”.`)]),
    );
  };

  const paint = (row: Row) => {
    const { entry } = row;
    row.set(entry.remaining, entry.period);
    if (!entry.code) {
      row.code.replaceChildren(h("span", { class: "muted small" }, "Unreadable secret"));
      return;
    }
    const codeEl = formatCode(entry.code);
    codeEl.classList.toggle("expiring", entry.remaining <= 5);
    row.code.replaceChildren(codeEl);
    row.next.textContent = entry.remaining <= 5 && entry.next ? `Next: ${entry.next}` : "";
  };

  search.addEventListener("input", draw);
  render(h("div", { class: "search" }, icon("search", 15), search), listEl);
  draw();
  search.focus();

  let refreshing = false;
  const tick = window.setInterval(async () => {
    let expired = false;
    for (const e of entries) {
      e.remaining--;
      if (e.remaining <= 0) expired = true;
    }
    for (const r of rows) paint(r);
    if (expired && !refreshing) {
      refreshing = true;
      const fresh = await send<TotpEntry[]>({ type: "totpList" }).catch(() => null);
      refreshing = false;
      if (fresh) {
        entries = fresh;
        draw();
      }
    }
  }, 1000);
  disposers.push(() => window.clearInterval(tick));
}

// ─── Generator ───────────────────────────────────────────────────────────────

const STRENGTH = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];

function loadOptions(): PasswordOptions {
  try {
    const raw = localStorage.getItem("minions-generator");
    if (raw) return { ...DEFAULT_PASSWORD_OPTIONS, ...(JSON.parse(raw) as PasswordOptions) };
  } catch {
    /* default */
  }
  return { ...DEFAULT_PASSWORD_OPTIONS };
}

function generatorView() {
  const opts = loadOptions();
  const out = h("div", { class: "pw" });
  const meter = h("div", { class: "meter" }, h("i"), h("i"), h("i"), h("i"));
  const strength = h("span", { class: "muted small" });
  const lengthLabel = h("strong", {});
  let pw = "";

  const save = () => {
    try {
      localStorage.setItem("minions-generator", JSON.stringify(opts));
    } catch {
      /* storage blocked */
    }
  };

  const regen = () => {
    if (!opts.uppercase && !opts.lowercase && !opts.numbers && !opts.symbols) opts.lowercase = true;
    pw = generatePassword(opts);
    // Digits and symbols coloured, so a password read aloud or retyped is unambiguous.
    out.replaceChildren(
      ...[...pw].map((c) =>
        /[0-9]/.test(c)
          ? h("span", { class: "d" }, c)
          : /[A-Za-z]/.test(c)
            ? c
            : h("span", { class: "s" }, c),
      ),
    );
    const s = estimateStrength(pw).score;
    meter.dataset.score = String(s);
    strength.textContent = STRENGTH[s] ?? "";
    lengthLabel.textContent = String(opts.length);
  };

  const slider = h("input", { type: "range", min: "8", max: "64", value: String(opts.length) });
  slider.addEventListener("input", () => {
    opts.length = Number(slider.value);
    save();
    regen();
  });

  const chip = (label: string, key: keyof PasswordOptions, text = false) => {
    const b = h("button", { type: "button", class: `chip${text ? " text" : ""}` }, label);
    b.setAttribute("aria-pressed", String(!!opts[key]));
    b.addEventListener("click", () => {
      (opts as unknown as Record<string, boolean>)[key] = !opts[key];
      b.setAttribute("aria-pressed", String(!!opts[key]));
      save();
      regen();
    });
    return b;
  };

  const copyBtn = h(
    "button",
    { type: "button", class: "lg block" },
    icon("copy", 15),
    "Copy password",
  );
  copyBtn.addEventListener("click", () => act(() => copy(pw, "Password")));

  render(
    h(
      "div",
      { class: "card" },
      out,
      h(
        "div",
        { class: "pw-actions" },
        h("div", { class: "grow" }, meter, h("div", { style: "margin-top:4px" }, strength)),
        iconButton("refresh", "New password", () => regen()),
        iconButton("copy", "Copy", () => act(() => copy(pw, "Password"))),
      ),
    ),
    h(
      "div",
      { class: "section" },
      h("div", { class: "row" }, h("span", { class: "grow" }, "Length"), lengthLabel),
      slider,
    ),
    h(
      "div",
      { class: "section" },
      h("div", { class: "section-title" }, "Characters"),
      h(
        "div",
        { class: "chips" },
        chip("A–Z", "uppercase"),
        chip("a–z", "lowercase"),
        chip("0–9", "numbers"),
        chip("!@#$", "symbols"),
        chip("Avoid look-alikes", "avoidAmbiguous", true),
      ),
    ),
    copyBtn,
  );
  regen();
}

// ─── Add ─────────────────────────────────────────────────────────────────────

function addView() {
  const text = h("textarea", {
    placeholder: "Paste an API key, a .env line, a card, an otpauth:// link, or describe it…",
  });
  const info = h("div", { class: "note", hidden: true });
  const name = h("input", { placeholder: "Name" });
  const saveBtn = h("button", { type: "button", class: "block", disabled: true }, "Save to vault");
  let t: number | undefined;
  text.addEventListener("input", () => {
    window.clearTimeout(t);
    t = window.setTimeout(async () => {
      if (!text.value.trim()) {
        info.hidden = true;
        saveBtn.disabled = true;
        return;
      }
      const r = await send<{
        label: string;
        provider?: string;
        confidence: number;
        name: string;
        secrets: number;
      }>({ type: "capture", text: text.value }).catch(() => null);
      if (!r) return;
      info.hidden = false;
      info.replaceChildren(
        icon(r.secrets ? "shield" : "sparkles", 14),
        h(
          "span",
          {},
          `${r.label}${r.provider ? ` · ${r.provider}` : ""} · ${Math.round(r.confidence * 100)}% sure · ${r.secrets ? "secret found, encrypted before saving" : "no secret found"}`,
        ),
      );
      if (!name.value || name.dataset.auto === "1") {
        name.value = r.name;
        name.dataset.auto = "1";
      }
      saveBtn.disabled = r.confidence < 0.6;
    }, 200);
  });
  name.addEventListener("input", () => {
    name.dataset.auto = "0";
  });
  saveBtn.addEventListener("click", () =>
    act(async () => {
      await send({ type: "saveCapture", text: text.value, name: name.value.trim() });
      text.value = "";
      name.value = "";
      info.hidden = true;
      saveBtn.disabled = true;
      toast("Saved. Add a project or tags in Minions.");
    }, saveBtn),
  );
  render(
    h(
      "div",
      { class: "section" },
      h("h2", {}, "Quick save"),
      h(
        "p",
        { class: "muted small" },
        "Minions recognises what you paste and encrypts the secret on this device.",
      ),
    ),
    text,
    info,
    h("label", {}, "Name", name),
    saveBtn,
  );
  text.focus();
}

// ─── Routing ─────────────────────────────────────────────────────────────────

async function vaultView(state: StateResponse) {
  lockBtn.hidden = false;
  tabsEl.hidden = false;
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  match =
    activeTab?.id !== undefined
      ? await send<MatchResponse>({ type: "match", tabId: activeTab.id }).catch(() => null)
      : null;
  hostEl.textContent = match?.host ?? "";

  const signOut = iconButton("logOut", "Sign out", async () => {
    await send({ type: "logout" });
    await route();
  });
  footer.replaceChildren(
    h("span", { class: "dot", title: "Connected" }),
    h("span", { class: "who" }, state.email ?? ""),
    signOut,
  );
  footer.hidden = false;

  // A login waiting to be saved, or logins for this site: start on Logins.
  if (match?.items.length) currentTab = "logins";
  drawTabs();
  showTab();
}

async function route() {
  lockBtn.hidden = true;
  tabsEl.hidden = true;
  footer.hidden = true;
  hostEl.textContent = "";
  const state = await send<StateResponse>({ type: "state" });
  if (state.status === "signed-out") return signInView(state);
  if (state.status === "two-factor") return twoFactorView();
  if (state.status === "locked") return lockedView(state);
  return vaultView(state);
}

lockBtn.append(icon("lock"));
openBtn.append(icon("external"));
lockBtn.addEventListener("click", async () => {
  await send({ type: "lock" });
  await route();
});
openBtn.addEventListener("click", async () => {
  const s = await send<StateResponse>({ type: "state" });
  void chrome.tabs.create({ url: s.webUrl });
});

// The background says so when the web app has connected or unlocked this extension.
chrome.runtime.onMessage.addListener((msg: { type?: string }, sender) => {
  if (sender.id === chrome.runtime.id && msg?.type === "minions-state-changed") void route();
});

void send({ type: "activity" }).catch(() => undefined);
void route();
