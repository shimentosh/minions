/**
 * Runs on web pages, top frame only. It never sees the vault key and never
 * reads the vault. It:
 *
 * - shows a small menu under a login field with the logins saved for this
 *   site (names and usernames only), and fills the one the user picks;
 * - fills the one credential the user picked in the popup;
 * - reports a login form submission so the background can ask whether to
 *   save it. Nothing is saved without the user pressing Save.
 *
 * Everything it draws lives in a closed shadow root, and only trusted (real
 * user) clicks and keys act on it: page scripts can neither read it nor press
 * its buttons.
 */
import type {
  BridgeHello,
  FillMessage,
  InlineItem,
  InlineMatch,
  PendingSave,
  Request,
  Response,
  SaveAction,
} from "./messages";

declare const __WEB_URL__: string;

/** This page is the Minions web app itself (top frame): bridge to it, never offer to save its login. */
const ON_APP = window.top === window && location.origin === new URL(__WEB_URL__).origin;

function call<T>(req: Request): Promise<Response<T> | null> {
  try {
    return chrome.runtime
      .sendMessage(req)
      .then((r: Response<T> | undefined) => r ?? null)
      .catch(() => null);
  } catch {
    // The extension was reloaded or removed: this page's script is orphaned.
    return Promise.resolve(null);
  }
}

async function send<T>(req: Request): Promise<T | null> {
  const r = await call<T>(req);
  return r?.ok ? r.data : null;
}

// ─── Finding login fields ────────────────────────────────────────────────────

const TEXTISH = 'input[type="email"], input[type="text"], input:not([type])';
const USERNAME_HINT = /user|e-?mail|login|account|identifier|signin/;
const NOT_LOGIN = /search|query|newsletter|subscri|coupon|promo|captcha|one-time|otp|zip|postal/;

function visible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
}

const hay = (i: HTMLInputElement) =>
  `${i.name} ${i.id} ${i.autocomplete} ${i.placeholder} ${i.getAttribute("aria-label") ?? ""}`.toLowerCase();

/** How much a text field looks like a username: -1 for fields that clearly are not one. */
function usernameScore(i: HTMLInputElement) {
  const h = hay(i);
  if (NOT_LOGIN.test(h) && !/user|e-?mail/.test(h)) return -1;
  return (
    (/\b(username|email)\b/.test(i.autocomplete) ? 3 : 0) +
    (USERNAME_HINT.test(h) ? 2 : 0) +
    (i.type === "email" ? 1 : 0)
  );
}

const usable = (i: HTMLInputElement) => !i.disabled && !i.readOnly && visible(i);
const isNew = (p: HTMLInputElement) => /new-password/.test(p.autocomplete);

function passwords() {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(usable);
}

const follows = (a: Node, b: Node) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/**
 * The username field that belongs with a password field: in its form, before
 * it, the most username-like, the nearest on a tie. With no password field
 * (step one of a two-step sign-in) only a clearly labelled field counts.
 */
function usernameFor(password: HTMLInputElement | null): HTMLInputElement | null {
  const scope: ParentNode = password?.form ?? document;
  const candidates = [...scope.querySelectorAll<HTMLInputElement>(TEXTISH)]
    .filter((i) => i !== password && usable(i) && (!password || follows(i, password)))
    .map((el, index) => ({ el, index, score: usernameScore(el) }))
    .filter((c) => c.score >= (password ? 0 : 2));
  candidates.sort((a, b) => b.score - a.score || b.index - a.index);
  return candidates[0]?.el ?? null;
}

/** Where a fill goes, starting from the field the user is in when there is one. */
function fieldsForFill(anchor: HTMLInputElement | null) {
  const pws = passwords();
  let password: HTMLInputElement | null = null;
  if (anchor?.type === "password") password = anchor;
  else if (anchor)
    password =
      pws.find((p) => p.form && p.form === anchor.form) ??
      pws.find((p) => follows(anchor, p)) ??
      null;
  // A change-password page: the saved password is the current one, not a new one.
  else
    password =
      pws.find((p) => /current-password/.test(p.autocomplete)) ??
      pws.find((p) => !isNew(p)) ??
      pws[0] ??
      null;
  const username = anchor && anchor.type !== "password" ? anchor : usernameFor(password);
  return { username, password };
}

/**
 * What the user just submitted. On a sign-up or change-password form the
 * password to keep is the new one, not the current one or its confirmation.
 */
function submitted(): { username: string; password: string } | null {
  const pws = passwords().filter((p) => p.value);
  if (!pws.length) return null;
  const fresh = pws.filter(isNew);
  const pw =
    fresh[0] ??
    (pws.length >= 3
      ? pws[1]!
      : pws.length === 2
        ? pws[0]!.value === pws[1]!.value
          ? pws[0]!
          : pws[1]!
        : pws[0]!);
  // Change-password forms often carry the username in a hidden field.
  const username =
    usernameFor(pw)?.value ||
    pw.form?.querySelector<HTMLInputElement>('input[autocomplete~="username"]')?.value ||
    "";
  return { username: username.trim(), password: pw.value };
}

function setValue(input: HTMLInputElement, value: string) {
  input.focus({ preventScroll: true });
  // The native setter, so frameworks that track the value (React and others) see the change.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: value }),
  );
  input.dispatchEvent(new Event("change", { bubbles: true }));
  flash(input);
}

/** A brief highlight on a filled field, then the page's own style back. */
function flash(input: HTMLInputElement) {
  const { boxShadow, transition } = input.style;
  input.style.transition = "box-shadow .2s ease";
  input.style.boxShadow = "0 0 0 3px rgba(99,102,241,.45)";
  setTimeout(() => {
    input.style.boxShadow = boxShadow;
    setTimeout(() => (input.style.transition = transition), 250);
  }, 700);
}

// ─── Shared look ─────────────────────────────────────────────────────────────

const PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
function colorFor(text: string) {
  let n = 0;
  for (const c of text) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[n % PALETTE.length]!;
}

/** The Minions logo (as in the web app), drawn here so no image is fetched from the page. */
const LOGO_SVG =
  '<svg viewBox="0 0 32 32" width="100%" height="100%"><rect width="32" height="32" rx="8" fill="#262626"/><path d="M10 14v-2a6 6 0 0 1 12 0v2" fill="none" stroke="#fafafa" stroke-width="2.4" stroke-linecap="round"/><rect x="8" y="14" width="16" height="11" rx="2.5" fill="#fafafa"/><circle cx="13" cy="19.5" r="1.6" fill="#262626"/><circle cx="19" cy="19.5" r="1.6" fill="#262626"/></svg>';
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const LOCK_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

const BASE_CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  .card{--bg:#fff;--fg:#171717;--muted:#737373;--line:rgba(0,0,0,.08);--hover:rgba(0,0,0,.045);--primary:#171717;--on-primary:#fafafa;--ring:rgba(99,102,241,.5);
    font:13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg);
    border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 32px -8px rgba(0,0,0,.22),0 2px 6px rgba(0,0,0,.06);
    -webkit-font-smoothing:antialiased;overflow:hidden}
  @media (prefers-color-scheme:dark){.card{--bg:#1c1c1e;--fg:#f5f5f5;--muted:#a1a1aa;--line:rgba(255,255,255,.09);--hover:rgba(255,255,255,.06);--primary:#fafafa;--on-primary:#171717}}
  .mark{flex:none;display:block;width:22px;height:22px;border-radius:7px;overflow:hidden;box-shadow:0 0 0 1px var(--line)}
  .mark svg{display:block}
  .av{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;color:#fff;font-weight:600;font-size:13px}
  .x{all:unset;cursor:pointer;display:grid;place-items:center;width:24px;height:24px;border-radius:6px;color:var(--muted);font-size:16px;line-height:1}
  .x:hover{background:var(--hover);color:var(--fg)}
  .x:focus-visible,button:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
  .muted{color:var(--muted)}
  .trunc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .err{color:#dc2626;font-size:12px}
  @media (prefers-color-scheme:dark){.err{color:#f87171}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  ...children: (Node | string | null | false)[]
) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) if (c) e.append(c);
  return e;
}

/** Fixed markup written here (icons), never page or vault data. */
function svg(markup: string, cls = "") {
  const span = el("span", cls);
  span.innerHTML = markup;
  return span;
}

/** A host element on top of the page, with a closed shadow root the page cannot reach. */
function overlay(id: string, css: string) {
  const host = document.createElement("div");
  host.id = id;
  host.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;";
  const root = host.attachShadow({ mode: "closed" });
  root.append(el("style", "", BASE_CSS + css));
  document.documentElement.appendChild(host);
  return { host, root };
}

// ─── The menu under a login field ────────────────────────────────────────────

const MENU_CSS = `
  .menu{width:var(--w,300px);animation:pop .14s ease-out}
  @keyframes pop{from{opacity:0;transform:translateY(-4px)}}
  .head{display:flex;align-items:center;gap:8px;padding:8px 8px 6px 10px;font-weight:600;font-size:12px}
  .head .t{flex:1}
  .list{padding:0 4px 4px;max-height:260px;overflow:auto}
  .item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;padding:7px 8px;border-radius:9px;cursor:pointer}
  .item[hidden]{display:none}
  .item:hover,.item.on{background:var(--hover)}
  .meta{flex:1;min-width:0;display:flex;flex-direction:column}
  .name{font-weight:550;font-size:13px}
  .sub{font-size:12px;color:var(--muted)}
  .badge{flex:none;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 7px;max-width:96px}
  .go{flex:none;font-size:11px;color:var(--muted);opacity:0}
  .item:hover .go,.item.on .go{opacity:1}
  .locked{display:flex;align-items:center;gap:10px;padding:6px 10px 10px}
  .locked .meta{font-size:12px}
  button.btn{all:unset;cursor:pointer;flex:none;font-weight:550;font-size:12px;padding:6px 10px;border-radius:8px;background:var(--primary);color:var(--on-primary)}
  .msg{padding:0 10px 10px}
`;

interface Menu {
  host: HTMLElement;
  root: ShadowRoot;
  box: HTMLElement;
  anchor: HTMLInputElement;
  /** Every login offered, and below, the ones still shown after typing. */
  all: { row: HTMLElement; pick: InlineItem }[];
  items: HTMLElement[];
  picks: InlineItem[];
  active: number;
}

let menu: Menu | null = null;
/** The user closed the menu: not again on this page. */
let menuDismissed = false;
/** Just filled: focus moving through the fields should not reopen it. */
let suppressUntil = 0;
/** Shown once per page while locked, so a locked vault does not nag on every field. */
let lockedShown = false;
let matchCache: { at: number; data: InlineMatch } | null = null;
let opening = 0;

/** A field the menu belongs under: a password, or a username next to one (or alone, clearly labelled). */
function isLoginField(t: EventTarget | null): t is HTMLInputElement {
  if (!(t instanceof HTMLInputElement) || !usable(t)) return false;
  if (t.type === "password") return !isNew(t);
  if (!t.matches(TEXTISH)) return false;
  const score = usernameScore(t);
  if (score < 0) return false;
  const pws = passwords();
  if (pws.length) return score >= 1 || pws.some((p) => p.form && p.form === t.form);
  return score >= 2;
}

async function inlineMatch(): Promise<InlineMatch | null> {
  // Logins are asked for once a minute at most; a locked vault is asked again each time.
  if (matchCache?.data.status === "unlocked" && Date.now() - matchCache.at < 60_000)
    return matchCache.data;
  const data = await send<InlineMatch>({ type: "inlineMatch" });
  matchCache = data ? { at: Date.now(), data } : null;
  return data;
}

function closeMenu() {
  menu?.host.remove();
  menu = null;
}

function placeMenu() {
  if (!menu) return;
  const r = menu.anchor.getBoundingClientRect();
  if (!menu.anchor.isConnected || r.width <= 0) return closeMenu();
  const width = Math.max(260, Math.min(r.width, 360));
  menu.box.style.setProperty("--w", `${width}px`);
  const h = menu.box.offsetHeight;
  const below = r.bottom + 6;
  const top = below + h > innerHeight - 8 && r.top - h - 6 > 8 ? r.top - h - 6 : below;
  const left = Math.min(Math.max(8, r.left), innerWidth - width - 8);
  menu.host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function setActive(i: number) {
  if (!menu) return;
  menu.active = i;
  for (const [n, it] of menu.items.entries()) it.classList.toggle("on", n === i);
  menu.items[i]?.scrollIntoView({ block: "nearest" });
}

/**
 * The user is typing it themselves. In a password field the menu steps out of
 * the way (it would cover the sign-in button); in a username field it keeps
 * only the logins that match what is typed, and closes when none do.
 */
function filterMenu() {
  if (!menu) return;
  const m = menu;
  if (m.anchor.type === "password") return closeMenu();
  const q = m.anchor.value.trim().toLowerCase();
  const shown = m.all.filter(
    ({ pick: p }) => !q || `${p.username ?? ""} ${p.name}`.toLowerCase().includes(q),
  );
  if (!shown.length) return closeMenu();
  for (const { row } of m.all) row.hidden = !shown.some((x) => x.row === row);
  m.items = shown.map((x) => x.row);
  m.picks = shown.map((x) => x.pick);
  setActive(-1);
  placeMenu();
}

/** The field a fill from the menu goes to (read by the fill handler). */
let fillAnchor: HTMLInputElement | null = null;

async function pick(item: InlineItem) {
  if (!menu) return;
  const m = menu;
  suppressUntil = Date.now() + 3000;
  fillAnchor = m.anchor;
  const r = await call({
    type: "inlineFill",
    itemId: item.id,
    ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
    ...(item.shared ? { shared: true } : {}),
  });
  fillAnchor = null;
  if (r?.ok) return closeMenu();
  showMenuMessage(m, r ? r.error : "Minions did not answer. Reload the page and try again.");
}

function showMenuMessage(m: Menu, text: string) {
  m.box.querySelector(".msg")?.remove();
  m.box.append(el("div", "msg err", text));
  placeMenu();
}

function buildMenu(anchor: HTMLInputElement, data: InlineMatch): Menu {
  const { host, root } = overlay("minions-fill-menu", MENU_CSS);
  const close = el("button", "x", "×");
  close.setAttribute("aria-label", "Close");
  const box = el(
    "div",
    "card menu",
    el("div", "head", svg(LOGO_SVG, "mark"), el("span", "t", "Minions"), close),
  );
  box.setAttribute("role", "listbox");
  const m: Menu = { host, root, box, anchor, all: [], items: [], picks: [], active: -1 };

  if (data.status === "unlocked") {
    const list = el("div", "list");
    for (const it of data.items) {
      const label = it.username || it.name;
      const av = el("span", "av", (it.name.trim()[0] ?? "?").toUpperCase());
      av.style.background = colorFor(it.name);
      const row = el(
        "button",
        "item",
        av,
        el(
          "span",
          "meta",
          el("span", "name trunc", it.name),
          it.username ? el("span", "sub trunc", it.username) : null,
        ),
        it.badge ? el("span", "badge trunc", it.badge) : null,
        el("span", "go", "Fill"),
      );
      row.type = "button";
      row.setAttribute("role", "option");
      row.title = `Fill ${label}`;
      row.addEventListener("click", (e) => {
        // A page script cannot press these for the user: synthetic clicks are ignored.
        if (e.isTrusted) void pick(it);
      });
      row.addEventListener("mouseenter", () => setActive(m.items.indexOf(row)));
      m.all.push({ row, pick: it });
      m.items.push(row);
      m.picks.push(it);
      list.append(row);
    }
    box.append(list);
  } else {
    const unlock = el("button", "btn", "Unlock");
    unlock.type = "button";
    unlock.addEventListener("click", async (e) => {
      if (!e.isTrusted) return;
      const r = await call({ type: "openPopup" });
      if (r?.ok) closeMenu();
      else showMenuMessage(m, r ? r.error : "Click the Minions icon in the toolbar to unlock");
    });
    box.append(
      el(
        "div",
        "locked",
        svg(LOCK_SVG, "muted"),
        el("span", "meta muted", "Unlock Minions to fill your saved login."),
        unlock,
      ),
    );
  }

  close.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    menuDismissed = true;
    closeMenu();
  });
  // Clicking the menu must not take focus from the field (that would close it).
  host.addEventListener("mousedown", (e) => e.preventDefault());
  root.append(box);
  return m;
}

async function openMenu(anchor: HTMLInputElement) {
  if (ON_APP || menuDismissed || Date.now() < suppressUntil) return;
  if (menu?.anchor === anchor) return;
  const ticket = ++opening;
  const data = await inlineMatch();
  // The user may have moved on while the background answered.
  if (ticket !== opening || document.activeElement !== anchor || !data) return;
  const showLocked = data.status === "locked" && anchor.type === "password" && !lockedShown;
  if (!(data.status === "unlocked" && data.items.length) && !showLocked) return closeMenu();
  if (showLocked) lockedShown = true;
  closeMenu();
  menu = buildMenu(anchor, data);
  placeMenu();
  // Typed into while the menu was on its way: treat it as typing.
  if (anchor.value && data.status === "unlocked") filterMenu();
}

let placing = false;
function schedulePlace() {
  if (!menu || placing) return;
  placing = true;
  requestAnimationFrame(() => {
    placing = false;
    placeMenu();
  });
}

if (!ON_APP) {
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (menu && t !== menu.anchor) closeMenu();
      if (isLoginField(t)) void openMenu(t);
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (e) => {
      if (!menu || e.target !== menu.anchor) return;
      const m = menu;
      setTimeout(() => {
        if (menu === m && document.activeElement !== m.anchor) closeMenu();
      }, 150);
    },
    true,
  );
  document.addEventListener(
    "input",
    (e) => {
      // Our own fill dispatches untrusted input events: only real typing counts.
      if (e.isTrusted && menu && e.target === menu.anchor) filterMenu();
    },
    true,
  );
  addEventListener("scroll", schedulePlace, { capture: true, passive: true });
  addEventListener("resize", schedulePlace, { passive: true });
  // A field focused before this script ran (autofocus on a sign-in page).
  if (isLoginField(document.activeElement)) void openMenu(document.activeElement);
}

// ─── Fill requests from the background ───────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    msg: FillMessage | { type: "minions-bridge-hello" } | { type: "minions-show-save" },
    sender,
    sendResponse,
  ) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.type === "minions-bridge-hello") {
      if (ON_APP) void hello();
      return;
    }
    if (msg?.type === "minions-show-save") {
      void showPrompt();
      return;
    }
    // Only the extension itself may ask for a fill, and only into the top frame.
    if (msg?.type !== "minions-fill") return;
    // The background checked the tab's address before decrypting; if the page
    // navigated since, it is a different origin now and gets nothing.
    if (window.top !== window || location.origin !== msg.origin) {
      sendResponse({ filled: false });
      return;
    }
    const focused = document.activeElement;
    const anchor = fillAnchor ?? (isLoginField(focused) ? focused : null);
    const { username, password } = fieldsForFill(anchor);
    suppressUntil = Date.now() + 3000;
    closeMenu();
    if (username && msg.username) setValue(username, msg.username);
    if (password && msg.password) setValue(password, msg.password);
    sendResponse({ filled: !!((username && msg.username) || (password && msg.password)) });
  },
);

// ─── Ask before saving a login the user just submitted ───────────────────────

let lastReported = "";
let lastUsername = "";

function report() {
  // The master password typed into Minions itself is never a login to save.
  if (ON_APP) return;
  const s = submitted();
  if (!s) return reportUsernameStep();
  // Remember only that this pair was reported, not the password itself.
  const key = `${s.username}\u0000${s.password.length}:${s.password.slice(-1)}`;
  if (key === lastReported) return;
  lastReported = key;
  void send({
    type: "formSubmitted",
    username: s.username.slice(0, 256),
    password: s.password.slice(0, 1024),
  }).then(() => setTimeout(showPrompt, 300));
}

/** Step one of a two-step sign-in (username now, password on the next screen). */
function reportUsernameStep() {
  const field = usernameFor(null);
  const value = field?.value.trim() ?? "";
  if (!value || value === lastUsername) return;
  lastUsername = value;
  void send({ type: "usernameSeen", username: value.slice(0, 256) });
}

document.addEventListener(
  "submit",
  (e) => {
    if (e.isTrusted) report();
  },
  true,
);
document.addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted) return;
    const t = e.target as HTMLElement | null;
    // Clicking back into a login field brings the menu back.
    if (!menu && isLoginField(t) && document.activeElement === t) void openMenu(t);
    const button = t?.closest("button, input[type=submit], input[type=button], [role=button]");
    if (button) report();
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    if (!e.isTrusted) return;
    if (menu && e.target === menu.anchor) {
      const n = menu.items.length;
      if (e.key === "ArrowDown" && n) {
        e.preventDefault();
        return setActive((menu.active + 1) % n);
      }
      if (e.key === "ArrowUp" && n) {
        e.preventDefault();
        return setActive((menu.active - 1 + n) % n);
      }
      if (e.key === "Escape") {
        // Closed for now; clicking the field brings it back.
        e.preventDefault();
        return closeMenu();
      }
      if (e.key === "Enter" && menu.active >= 0) {
        // Enter on a highlighted login fills it instead of submitting the form.
        e.preventDefault();
        e.stopImmediatePropagation();
        void pick(menu.picks[menu.active]!);
        return;
      }
    }
    if (e.key === "Enter" && (e.target as HTMLElement | null)?.tagName === "INPUT") report();
  },
  true,
);

const PROMPT_CSS = `
  .prompt{width:340px;animation:in .22s cubic-bezier(.2,.9,.3,1.2)}
  .prompt.out{animation:out .2s ease-in forwards}
  @keyframes in{from{opacity:0;transform:translateY(-10px) scale(.98)}}
  @keyframes out{to{opacity:0;transform:translateY(-6px) scale(.98)}}
  .head{display:flex;align-items:flex-start;gap:10px;padding:14px 12px 0 14px}
  .head .mark{width:28px;height:28px;border-radius:9px}
  .titles{flex:1;min-width:0}
  .title{font-weight:600;font-size:14px}
  .sub{font-size:12px;color:var(--muted)}
  .cred{margin:12px 14px 0;border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .line{display:flex;gap:10px;padding:7px 10px;font-size:12px}
  .line+.line{border-top:1px solid var(--line)}
  .k{flex:none;width:68px;color:var(--muted)}
  .v{flex:1;min-width:0}
  .dots{letter-spacing:2px}
  .row{display:flex;align-items:center;gap:6px;padding:12px 12px 12px 14px}
  .grow{flex:1}
  button.b{all:unset;cursor:pointer;font-weight:550;font-size:12.5px;padding:7px 12px;border-radius:8px}
  button.b.primary{background:var(--primary);color:var(--on-primary);padding:7px 16px}
  button.b.primary:hover{opacity:.88}
  button.b.ghost{color:var(--fg)}
  button.b.ghost:hover,button.b.link:hover{background:var(--hover)}
  button.b.link{color:var(--muted);font-weight:500;font-size:12px;padding:7px 8px}
  .done{display:flex;align-items:center;gap:10px;padding:14px;font-weight:600}
  .done .ok{display:grid;place-items:center;width:28px;height:28px;border-radius:999px;background:#10b981;color:#fff}
  .err{padding:8px 14px 0}
  button.b[disabled]{opacity:.55;cursor:default}
`;

async function showPrompt() {
  if (ON_APP) return;
  const pending = await send<PendingSave>({ type: "pendingSave" });
  if (!pending || document.getElementById("minions-save-prompt")) return;
  const { host, root } = overlay("minions-save-prompt", PROMPT_CSS);
  host.style.top = "16px";
  host.style.left = "auto";
  host.style.right = "16px";
  const isUpdate = !!pending.updateItemId;

  const button = (cls: string, label: string, action: SaveAction) => {
    const b = el("button", `b ${cls}`, label);
    b.type = "button";
    b.dataset.a = action;
    return b;
  };
  const close = el("button", "x", "×");
  close.setAttribute("aria-label", "Not now");
  close.dataset.a = "ignore";
  // Text through textContent only: page-controlled strings never become markup.
  const card = el(
    "div",
    "card prompt",
    el(
      "div",
      "head",
      svg(LOGO_SVG, "mark"),
      el(
        "div",
        "titles",
        el(
          "div",
          "title trunc",
          isUpdate
            ? `Update password for ${pending.updateItemName}?`
            : "Save this login to Minions?",
        ),
        el("div", "sub trunc", pending.host),
      ),
      close,
    ),
    el(
      "div",
      "cred",
      pending.username
        ? el("div", "line", el("span", "k", "Username"), el("span", "v trunc", pending.username))
        : null,
      el(
        "div",
        "line",
        el("span", "k", isUpdate ? "New password" : "Password"),
        el("span", "v dots", "••••••••••"),
      ),
    ),
    el(
      "div",
      "row",
      isUpdate ? null : button("link", "Never for this site", "never"),
      el("span", "grow"),
      button("ghost", "Not now", "ignore"),
      button("primary", isUpdate ? "Update" : "Save", isUpdate ? "update" : "save"),
    ),
  );
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Save to Minions");
  root.append(card);

  let timer = 0;
  const remove = () => {
    window.clearTimeout(timer);
    card.classList.add("out");
    setTimeout(() => host.remove(), 220);
  };
  // Left alone it goes away; while the pointer is on it, it waits.
  const later = (ms: number) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(remove, ms);
  };
  card.addEventListener("mouseenter", () => window.clearTimeout(timer));
  card.addEventListener("mouseleave", () => later(20_000));
  later(60_000);

  let busy = false;
  root.addEventListener("click", async (e) => {
    // A page script cannot press these for the user: synthetic clicks are ignored.
    if (!e.isTrusted || busy) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    const action = target?.dataset.a as SaveAction | undefined;
    if (!action) return;
    busy = true;
    for (const b of root.querySelectorAll("button")) b.disabled = true;
    const r = await call({ type: "resolveSave", id: pending.id, action });
    if (action !== "save" && action !== "update") return remove();
    if (!r?.ok) {
      busy = false;
      for (const b of root.querySelectorAll("button")) b.disabled = false;
      card.querySelector(".err")?.remove();
      card.insertBefore(
        el("div", "err", r ? r.error : "Minions did not answer. Try from the toolbar."),
        card.querySelector(".row"),
      );
      return;
    }
    matchCache = null;
    card.replaceChildren(
      el(
        "div",
        "done",
        svg(CHECK_SVG, "ok"),
        el("span", "", action === "update" ? "Password updated" : "Saved to Minions"),
      ),
    );
    later(1600);
  });
}

// A full-page navigation after login lands here: show any pending prompt.
void showPrompt();

// ─── Bridge to the Minions web app ───────────────────────────────────────────
// On the app's own origin only. The app hands over a session and the vault
// key here; the background checks the sender's address itself and accepts a
// link only with a nonce it gave out in a hello.

const FROM_APP = "minions-app";
const FROM_EXTENSION = "minions-extension";

function toApp(data: Record<string, unknown>) {
  window.postMessage({ source: FROM_EXTENSION, ...data }, location.origin);
}

async function hello() {
  const h = await send<BridgeHello>({ type: "bridgeHello" });
  if (h) toApp({ type: "hello", ...h });
}

if (ON_APP) {
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || d.source !== FROM_APP) return;
    if (d.type === "ping") void hello();
    else if (d.type === "link") {
      const req = {
        type: "bridgeLink",
        nonce: d.nonce,
        token: d.token,
        userId: d.userId,
        vaultId: d.vaultId,
        email: d.email,
        autoLockMinutes: d.autoLockMinutes,
        vaultKey: d.vaultKey,
        privateKey: d.privateKey ?? null,
      } as Request;
      chrome.runtime
        .sendMessage(req)
        .then((r: Response | undefined) =>
          toApp({ type: "linked", ok: !!r?.ok, ...(r && !r.ok ? { error: r.error } : {}) }),
        )
        .catch(() => toApp({ type: "linked", ok: false, error: "The extension did not answer" }))
        .finally(() => void hello());
    }
  });
  void hello();
}
