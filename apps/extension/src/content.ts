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
  TotpCode,
} from "./messages";

declare const __WEB_URL__: string;

/** This page is the Minions web app itself (top frame): bridge to it, never offer to save its login. */
const ON_APP = window.top === window && location.origin === new URL(__WEB_URL__).origin;

// ─── Left behind by an extension reload ──────────────────────────────────────
// Reloading or updating the extension cuts off the copy of this script that
// is already in each open page. That copy then stops and takes its menu and
// button away, so a fresh copy (added by the background) works instead of it.

const life = new AbortController();
const observers: MutationObserver[] = [];

function alive() {
  if (chrome.runtime?.id) return true;
  if (!life.signal.aborted) {
    life.abort();
    for (const o of observers) o.disconnect();
    try {
      closeMenu();
      fieldIcon?.host.remove();
    } catch {
      // Not built yet.
    }
  }
  return false;
}

/** A page-wide listener that goes away with this copy of the script. */
function listen<K extends keyof WindowEventMap>(
  target: Window | Document,
  type: K,
  fn: (e: WindowEventMap[K]) => void,
  opts: boolean | AddEventListenerOptions = false,
) {
  const o = typeof opts === "boolean" ? { capture: opts } : opts;
  target.addEventListener(
    type,
    (e) => {
      if (alive()) fn(e as WindowEventMap[K]);
    },
    { ...o, signal: life.signal },
  );
}

function call<T>(req: Request): Promise<Response<T> | null> {
  if (!alive()) return Promise.resolve(null);
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
const NOT_LOGIN =
  /search|query|newsletter|subscri|coupon|promo|captcha|one-time|\botp\b|2fa|mfa|zip|postal/;

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
function submitted(): {
  username: string;
  password: string;
  field: HTMLInputElement;
  fresh: boolean;
} | null {
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
  return {
    username: username.trim(),
    password: pw.value,
    field: pw,
    // A sign-up or change-password field: a password the user meant to set.
    fresh: fresh.length > 0 || isNewPasswordField(pw),
  };
}

function setValue(input: HTMLInputElement, value: string) {
  filling = true;
  try {
    input.focus({ preventScroll: true });
  } finally {
    filling = false;
  }
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

// ─── What kind of field this is ──────────────────────────────────────────────

/**
 * login         a username or password on a sign-in form: the site's saved logins
 * new-password  a sign-up or change-password field: a generated password
 * signup-email  the email on a sign-up form: the user's own email
 * otp           a two-factor code field: the code from the site's saved login
 */
type FieldKind = "login" | "new-password" | "signup-email" | "otp";

const OTP_HINT =
  /one-?time|\botp\b|totp|2fa|mfa|two.?factor|verification.?code|security.?code|auth\w*.?code|\bcode\b/;
const NOT_OTP = /zip|postal|promo|coupon|discount|voucher|gift|referral|invite|country|phone|area/;
const SIGNUP_WORDS = /sign\s?up|register|create (an |your |my )?account|get started|join now/i;
const SIGNIN_WORDS = /sign\s?in|log\s?in/i;

const scopeOf = (i: HTMLInputElement): ParentNode => i.form ?? document;
const isCurrent = (p: HTMLInputElement) => /current-password/.test(p.autocomplete);

function passwordsIn(scope: ParentNode) {
  return [...scope.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(usable);
}

/** A sign-up form: a new password, a password asked twice, or a form that says so. */
function isSignupScope(scope: ParentNode) {
  const pws = passwordsIn(scope);
  if (pws.some(isCurrent)) return false;
  if (pws.some(isNew) || pws.length >= 2) return true;
  // Button wording only within a form: a page-wide "Sign up" link proves nothing.
  if (!(scope instanceof HTMLFormElement)) return false;
  const words = [
    ...scope.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"]'),
  ]
    .map((b) => (b instanceof HTMLInputElement ? b.value : (b.textContent ?? "")))
    .join(" ");
  const named = `${scope.id} ${scope.className} ${scope.getAttribute("action") ?? ""}`;
  return (SIGNUP_WORDS.test(words) || /signup|register/i.test(named)) && !SIGNIN_WORDS.test(words);
}

/** A password field that wants a new password (sign-up, or the new one when changing it). */
function isNewPasswordField(p: HTMLInputElement) {
  if (isNew(p)) return true;
  if (isCurrent(p)) return false;
  const pws = passwordsIn(scopeOf(p));
  if (pws.some(isCurrent)) return true;
  if (pws.length >= 3) return pws.indexOf(p) > 0;
  if (pws.length === 2) return true;
  return isSignupScope(scopeOf(p));
}

function classify(t: EventTarget | null): FieldKind | null {
  if (!(t instanceof HTMLInputElement) || !usable(t)) return null;
  if (t.type === "password") return isNewPasswordField(t) ? "new-password" : "login";
  const h = hay(t);
  if (
    t.matches(`${TEXTISH}, input[type="tel"], input[type="number"]`) &&
    (/one-time-code/.test(t.autocomplete) || (OTP_HINT.test(h) && !NOT_OTP.test(h)))
  )
    return "otp";
  if (!t.matches(TEXTISH)) return null;
  const score = usernameScore(t);
  if (score < 0) return null;
  if (isSignupScope(scopeOf(t)))
    return t.type === "email" || /e-?mail/.test(h) ? "signup-email" : null;
  const pws = passwords();
  if (pws.length)
    return score >= 1 || pws.some((p) => p.form && p.form === t.form) ? "login" : null;
  return score >= 2 ? "login" : null;
}

const isLoginField = (t: EventTarget | null): t is HTMLInputElement => classify(t) === "login";

// ─── The menu under a field ──────────────────────────────────────────────────

const MENU_CSS = `
  .menu{width:var(--w,300px);animation:pop .14s ease-out}
  @keyframes pop{from{opacity:0;transform:translateY(-4px)}}
  .head{display:flex;align-items:center;gap:8px;padding:8px 8px 6px 10px;font-weight:600;font-size:12px}
  .head .t{flex:1;min-width:0}
  .head .host{font-weight:400;color:var(--muted)}
  .list{padding:0 4px 4px;max-height:280px;overflow:auto}
  .item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;padding:7px 8px;border-radius:9px;cursor:pointer}
  .item[hidden]{display:none}
  .group{padding:8px 8px 4px;font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
  .item.ask{background:var(--hover)}
  .item.ask .go{opacity:1;color:var(--on-primary);background:var(--primary);border-radius:6px;padding:3px 8px;font-weight:600}
  .item.ask .sub{color:var(--fg);white-space:normal}
  .item:hover,.item.on{background:var(--hover)}
  .meta{flex:1;min-width:0;display:flex;flex-direction:column}
  .name{font-weight:550;font-size:13px}
  .sub{font-size:12px;color:var(--muted)}
  .pw{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);letter-spacing:.2px}
  .pw .d{color:#2563eb}.pw .s{color:#db2777}
  @media (prefers-color-scheme:dark){.pw .d{color:#60a5fa}.pw .s{color:#f472b6}}
  .ic{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--hover);color:var(--fg)}
  .code{flex:none;font:600 15px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1px}
  .secs{flex:none;min-width:30px;text-align:center;font-size:11px;font-weight:600;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 6px}
  .secs.low{color:#dc2626;border-color:rgba(220,38,38,.35)}
  .badge{flex:none;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 7px;max-width:96px}
  .go{flex:none;font-size:11px;color:var(--muted);opacity:0}
  .item:hover .go,.item.on .go{opacity:1}
  .info{display:flex;align-items:center;gap:10px;padding:4px 10px 10px;font-size:12px}
  .info .meta{color:var(--muted)}
  button.btn{all:unset;cursor:pointer;flex:none;font-weight:550;font-size:12px;padding:6px 10px;border-radius:8px;background:var(--primary);color:var(--on-primary)}
  .msg{padding:0 10px 10px}
  .del{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:6px;color:var(--muted);opacity:0;transition:opacity .1s ease}
  .item:hover .del,.item.on .del{opacity:1}
  .del:hover{color:#dc2626;background:rgba(220,38,38,.12)}
  .item.busy{opacity:.5;pointer-events:none}
  .item.trashed{cursor:default}
  .item.trashed .name{color:var(--muted);font-weight:500}
  .undo{flex:none;font-size:12px;font-weight:600;padding:3px 9px;border-radius:6px;border:1px solid var(--line);color:var(--fg);cursor:pointer}
  .undo:hover{background:var(--hover)}
`;

const PLUS_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>';
const MAIL_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';
const TIMER_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>';
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
const REFRESH_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';

/** One choice in the menu: what it shows, what typing matches, what picking it does. */
interface Row {
  el: HTMLElement;
  /** Text typing filters on; null rows are never filtered out. */
  match: string | null;
  /** Fills the page; resolves to an error to show, or null. */
  run: () => Promise<string | null>;
  /** A small heading shown above this row (the start of a group). */
  heading?: string;
}

interface Menu {
  host: HTMLElement;
  root: ShadowRoot;
  box: HTMLElement;
  anchor: HTMLInputElement;
  kind: FieldKind;
  rows: Row[];
  /** The rows still shown after typing. */
  shown: Row[];
  active: number;
  /** Only a note (locked, nothing saved): shown above the field, out of the way. */
  note: boolean;
  /** Timers to stop when it closes (live 2FA codes). */
  cleanup: (() => void)[];
}

let menu: Menu | null = null;
/** The user closed the menu: not again on this page. */
let menuDismissed = false;
/** Minions itself is moving focus through the fields it fills: no menu for that. */
let filling = false;
/** Notes (locked, nothing saved here) are shown once per page, not on every field. */
let noteShown = false;
let matchCache: { at: number; data: InlineMatch } | null = null;
let opening = 0;

async function inlineMatch(): Promise<InlineMatch | null> {
  // Asked once a minute at most while unlocked; otherwise each time, so an unlock shows at once.
  if (matchCache?.data.status === "unlocked" && Date.now() - matchCache.at < 60_000)
    return matchCache.data;
  const data = await send<InlineMatch>({ type: "inlineMatch" });
  matchCache = data ? { at: Date.now(), data } : null;
  return data;
}

function closeMenu() {
  if (!menu) return;
  for (const stop of menu.cleanup) stop();
  menu.host.remove();
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
  const above = r.top - h - 6;
  // A note goes above, so it never covers the next field (the password under a username).
  const top = above > 8 && (menu.note || below + h > innerHeight - 8) ? above : below;
  const left = Math.min(Math.max(8, r.left), innerWidth - width - 8);
  menu.host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function setActive(i: number) {
  if (!menu) return;
  menu.active = i;
  for (const [n, r] of menu.shown.entries()) r.el.classList.toggle("on", n === i);
  menu.shown[i]?.el.scrollIntoView({ block: "nearest" });
}

/**
 * The user is typing it themselves. Over a password or a code the menu steps
 * out of the way (it would cover the button); elsewhere it keeps only the
 * choices that match what is typed, and closes when none do.
 */
function filterMenu() {
  if (!menu) return;
  const m = menu;
  if (m.kind === "new-password" || m.kind === "otp" || m.anchor.type === "password")
    return closeMenu();
  const q = m.anchor.value.trim().toLowerCase();
  const shown = m.rows.filter((r) => r.match === null || !q || r.match.includes(q));
  if (!shown.some((r) => r.match !== null)) return closeMenu();
  for (const r of m.rows) r.el.hidden = !shown.includes(r);
  m.shown = shown;
  setActive(-1);
  placeMenu();
}

function showMenuMessage(m: Menu, text: string) {
  m.box.querySelector(".msg")?.remove();
  m.box.append(el("div", "msg err", text));
  placeMenu();
}

/** A row's answer meaning "stay open" (it is asking the user to confirm). */
const KEEP = "\u0000keep";

async function choose(row: Row) {
  const m = menu;
  if (!m) return;
  const error = await row.run();
  if (error === KEEP) return;
  if (error) showMenuMessage(m, error);
  else closeMenu();
}

function rowButton(
  icon: HTMLElement,
  title: string,
  sub: Node | string | null,
  extra: (Node | null)[] = [],
) {
  const b = el(
    "button",
    "item",
    icon,
    el("span", "meta", el("span", "name trunc", title), sub ? el("span", "sub trunc", sub) : null),
    ...extra,
  );
  b.type = "button";
  b.setAttribute("role", "option");
  return b;
}

function letterIcon(name: string) {
  const av = el("span", "av", (name.trim()[0] ?? "?").toUpperCase());
  av.style.background = colorFor(name);
  return av;
}

/** A generated password with digits and symbols coloured, so it reads unambiguously. */
function passwordText(pw: string) {
  const span = el("span", "pw trunc");
  for (const c of pw)
    span.append(/[0-9]/.test(c) ? el("span", "d", c) : /[A-Za-z]/.test(c) ? c : el("span", "s", c));
  return span;
}

/** Fills a code into one field, or across a row of one-character boxes. */
function fillCode(anchor: HTMLInputElement, code: string) {
  if (anchor.maxLength !== 1) return setValue(anchor, code);
  const boxes = [
    ...(anchor.parentElement?.parentElement ?? document).querySelectorAll<HTMLInputElement>(
      "input",
    ),
  ].filter((i) => i.maxLength === 1 && usable(i));
  const start = Math.max(0, boxes.indexOf(anchor));
  [...code].forEach((c, n) => {
    const box = boxes[start + n];
    if (box) setValue(box, c);
  });
}

/** The field a login fill from the menu goes to (read by the fill handler). */
let fillAnchor: HTMLInputElement | null = null;

function itemRef(it: InlineItem) {
  return {
    itemId: it.id,
    ...(it.workspaceId ? { workspaceId: it.workspaceId } : {}),
    ...(it.shared ? { shared: true } : {}),
  };
}

/** A small action inside a row (the row itself is the button that fills). */
function rowAction(cls: string, content: HTMLElement | string, label: string, run: () => void) {
  const a = el("span", cls, content);
  a.setAttribute("role", "button");
  a.setAttribute("aria-label", label);
  a.title = label;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.isTrusted) run();
  });
  return a;
}

function loginRow(it: InlineItem, anchor: HTMLInputElement): Row {
  // Personal logins can be cleared out from here; team and shared ones belong to others.
  const personal = !it.workspaceId && !it.shared;
  const row = rowButton(letterIcon(it.name), it.name, it.username, [
    it.badge ? el("span", "badge trunc", it.badge) : null,
    el("span", "go", "Fill"),
    personal
      ? rowAction(
          "del",
          svg(TRASH_SVG),
          `Move ${it.username || it.name} to the Trash`,
          () => void trashRow(r, it),
        )
      : null,
  ]);
  row.title = `Fill ${it.username || it.name}`;
  const r: Row = {
    el: row,
    match: `${it.username ?? ""} ${it.name}`.toLowerCase(),
    run: async () => {
      fillAnchor = anchor;
      const res = await call({ type: "inlineFill", ...itemRef(it) });
      fillAnchor = null;
      return res?.ok
        ? null
        : (res?.error ?? "Minions was updated. Reload this page, then try again.");
    },
  };
  return r;
}

/**
 * Moves a login the user no longer needs to the Trash, right from the menu.
 * The row then says so, with an Undo; the Trash in Minions keeps it as well.
 */
async function trashRow(r: Row, it: InlineItem) {
  const m = menu;
  const before = [...r.el.childNodes];
  const fill = r.run;
  r.el.classList.add("busy");
  const res = await call({ type: "inlineTrash", itemId: it.id });
  r.el.classList.remove("busy");
  if (!res?.ok) {
    if (m) showMenuMessage(m, res?.error ?? "Minions did not answer. Reload this page.");
    return;
  }
  matchCache = null;
  r.run = async () => KEEP;
  r.el.classList.add("trashed");
  r.el.title = "";
  r.el.replaceChildren(
    el("span", "ic", svg(TRASH_SVG)),
    el(
      "span",
      "meta",
      el("span", "name trunc", "Moved to the Trash"),
      el("span", "sub trunc", it.username || it.name),
    ),
    rowAction("undo", "Undo", "Undo: put this login back", async () => {
      r.el.classList.add("busy");
      const back = await call({ type: "inlineRestore", itemId: it.id });
      r.el.classList.remove("busy");
      if (!back?.ok) {
        if (menu) showMenuMessage(menu, back?.error ?? "Could not put it back");
        return;
      }
      matchCache = null;
      r.run = fill;
      r.el.classList.remove("trashed");
      r.el.title = `Fill ${it.username || it.name}`;
      r.el.replaceChildren(...before);
    }),
  );
}

/** A login saved without a website: the first click asks, the second fills and remembers. */
function unlinkedRow(it: InlineItem, anchor: HTMLInputElement, host: string | null): Row {
  const go = el("span", "go", "Fill");
  const row = rowButton(letterIcon(it.name), it.name, it.username ?? "No website saved", [
    el("span", "badge", "No website"),
    go,
  ]);
  row.title = `Fill ${it.username || it.name}`;
  let asked = false;
  return {
    el: row,
    match: `${it.username ?? ""} ${it.name}`.toLowerCase(),
    run: async () => {
      if (!asked) {
        asked = true;
        row.classList.add("ask");
        const sub = row.querySelector(".meta")?.lastElementChild;
        if (sub) sub.textContent = `Fill here and remember ${host ?? "this site"} on it?`;
        go.textContent = "Confirm";
        return KEEP;
      }
      fillAnchor = anchor;
      const r = await call({ type: "inlineFill", ...itemRef(it), link: true });
      fillAnchor = null;
      matchCache = null;
      return r?.ok ? null : (r?.error ?? "Minions was updated. Reload this page, then try again.");
    },
  };
}

function rowsFor(m: Menu, data: InlineMatch): Row[] {
  const anchor = m.anchor;
  const ref = itemRef;

  if (m.kind === "login")
    return [
      ...data.items.map((it) => loginRow(it, anchor)),
      // Saved without a website, but named like this site: offered, confirmed, then remembered.
      ...data.suggested.map((it, n) => ({
        ...unlinkedRow(it, anchor, data.host),
        ...(n === 0 ? { heading: "Saved without a website" } : {}),
      })),
    ];

  if (m.kind === "otp")
    return data.items
      .filter((it) => it.hasTotp)
      .map((it) => {
        // The live code, shown before it is used; refreshed as it runs out.
        const code = el("span", "code", "··· ···");
        const secs = el("span", "secs", "");
        let left = 0;
        const peek = async () => {
          const r = await send<TotpCode>({ type: "inlineTotp", ...ref(it), peek: true });
          if (!r) return;
          const mid = r.code.length === 8 ? 4 : 3;
          code.textContent = `${r.code.slice(0, mid)} ${r.code.slice(mid)}`;
          left = r.remaining;
          secs.textContent = `${left}s`;
          secs.classList.toggle("low", left <= 5);
        };
        void peek();
        const tick = window.setInterval(() => {
          left--;
          if (left <= 0) return void peek();
          secs.textContent = `${left}s`;
          secs.classList.toggle("low", left <= 5);
        }, 1000);
        m.cleanup.push(() => window.clearInterval(tick));
        const row = rowButton(svg(TIMER_SVG, "ic"), it.name, it.username ?? "2FA code", [
          code,
          secs,
        ]);
        row.title = "Fill this code";
        return {
          el: row,
          match: null,
          run: async () => {
            // Fetched again when used, so the code is current and the use recorded.
            const r = await call<TotpCode>({ type: "inlineTotp", ...ref(it) });
            if (!r?.ok) return r?.error ?? "Minions was updated. Reload this page, then try again.";
            fillCode(anchor, r.data.code);
            return null;
          },
        };
      });

  if (m.kind === "signup-email")
    return data.emails.map((email) => ({
      el: rowButton(svg(MAIL_SVG, "ic"), email, "Your email", [el("span", "go", "Fill")]),
      match: email.toLowerCase(),
      run: async () => {
        setValue(anchor, email);
        return null;
      },
    }));

  // A new password: generated here, shown, and put into the field and its confirmation.
  let pw = "";
  const text = el("span", "pw trunc", "…");
  const again = svg(REFRESH_SVG, "x");
  again.title = "Another one";
  const row = rowButton(svg(PLUS_SVG, "ic"), "Use a strong password", text, [again]);
  const regen = async () => {
    pw = (await send<string>({ type: "inlineGenerate" })) ?? "";
    row.querySelector(".meta")?.lastElementChild?.replaceWith(passwordText(pw));
    placeMenu();
  };
  again.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.isTrusted) void regen();
  });
  void regen();
  return [
    {
      el: row,
      match: null,
      run: async () => {
        if (!pw) return "Could not make a password. Try again.";
        const targets = passwordsIn(scopeOf(anchor)).filter(
          (p) => p === anchor || isNewPasswordField(p),
        );
        for (const p of targets) if (!p.value || p === anchor) setValue(p, pw);
        return null;
      },
    },
  ];
}

/** A one-line note with an optional button (locked, signed out, nothing saved). */
function note(m: Menu, icon: string, text: string, action?: { label: string; run: () => void }) {
  const parts: (Node | null)[] = [svg(icon, "muted"), el("span", "meta", text)];
  if (action) {
    const b = el("button", "btn", action.label);
    b.type = "button";
    b.addEventListener("click", (e) => {
      if (e.isTrusted) action.run();
    });
    parts.push(b);
  }
  m.box.append(el("div", "info", ...parts));
}

function unlockAction(m: Menu, label: string) {
  return {
    label,
    run: async () => {
      const r = await call({ type: "openPopup" });
      if (r?.ok) closeMenu();
      else showMenuMessage(m, r?.error ?? "Click the Minions icon in the toolbar");
    },
  };
}

/** Builds the menu for a field, or null when there is nothing worth showing. */
function buildMenu(anchor: HTMLInputElement, kind: FieldKind, data: InlineMatch): Menu | null {
  const unlocked = data.status === "unlocked";
  const signedIn = unlocked || data.status === "locked";
  // What each kind needs: logins and codes need the vault; an email needs the
  // account; a generated password needs nothing.
  const needsVault = kind === "login" || kind === "otp";
  if (kind === "signup-email" && !data.emails.length) return null;
  if (kind === "otp" && unlocked && !data.items.some((i) => i.hasTotp)) return null;
  const emptyLogin = kind === "login" && unlocked && !data.items.length && !data.suggested.length;
  const showNote = (needsVault && !unlocked) || emptyLogin;
  if (showNote && (noteShown || (kind === "otp" && !unlocked))) return null;

  const { host, root } = overlay("minions-fill-menu", MENU_CSS);
  const close = el("button", "x", "×");
  close.setAttribute("aria-label", "Close");
  const box = el(
    "div",
    "card menu",
    el(
      "div",
      "head",
      svg(LOGO_SVG, "mark"),
      el("span", "t trunc", "Minions", data.host ? el("span", "host", ` · ${data.host}`) : null),
      close,
    ),
  );
  box.setAttribute("role", "listbox");
  const m: Menu = {
    host,
    root,
    box,
    anchor,
    kind,
    rows: [],
    shown: [],
    active: -1,
    note: showNote,
    cleanup: [],
  };

  if (showNote) {
    noteShown = true;
    if (emptyLogin) {
      note(m, LOCK_SVG, "No saved login here yet. Sign in and Minions offers to save it.");
      setTimeout(() => menu === m && closeMenu(), 6000);
    } else if (signedIn) note(m, LOCK_SVG, "Unlock Minions to fill.", unlockAction(m, "Unlock"));
    else note(m, LOCK_SVG, "Sign in to Minions to fill.", unlockAction(m, "Sign in"));
  } else {
    m.rows = rowsFor(m, data);
    m.shown = [...m.rows];
    const list = el("div", "list");
    for (const r of m.rows) {
      if (r.heading) list.append(el("div", "group", r.heading));
      r.el.addEventListener("click", (e) => {
        // A page script cannot press these for the user: synthetic clicks are ignored.
        if (e.isTrusted) void choose(r);
      });
      r.el.addEventListener("mouseenter", () => setActive(m.shown.indexOf(r)));
      list.append(r.el);
    }
    box.append(list);
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

/** `auto`: opened by Minions itself (a 2FA field appeared), not by the user focusing it. */
async function openMenu(anchor: HTMLInputElement, kind: FieldKind, auto = false) {
  if (ON_APP || menuDismissed || filling) return;
  if (menu?.anchor === anchor) return;
  const ticket = ++opening;
  const data = await inlineMatch();
  // The user may have moved on while the background answered.
  if (ticket !== opening || !data?.enabled) return;
  if (!auto && document.activeElement !== anchor) return;
  if (auto && (menu || anchor.value)) return;
  closeMenu();
  menu = buildMenu(anchor, kind, data);
  if (!menu) return;
  placeMenu();
  // Typed into while the menu was on its way: treat it as typing.
  if (anchor.value && menu.rows.length) filterMenu();
}

/** 2FA fields already offered on their own, so each pops up once. */
const offered = new WeakSet<HTMLInputElement>();

/** A 2FA code field has appeared: offer the code without waiting for a click. */
function scanForCodeField() {
  if (menu || menuDismissed) return;
  const field = [...document.querySelectorAll<HTMLInputElement>("input")].find(
    (i) => !offered.has(i) && !i.value && classify(i) === "otp",
  );
  if (!field) return;
  offered.add(field);
  void openMenu(field, "otp", true);
}

function maybeOpen(t: EventTarget | null) {
  const kind = classify(t);
  if (kind) void openMenu(t as HTMLInputElement, kind);
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
  listen(
    document,
    "focusin",
    (e) => {
      if (menu && e.target !== menu.anchor) closeMenu();
      maybeOpen(e.target);
    },
    true,
  );
  listen(
    document,
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
  listen(
    document,
    "input",
    (e) => {
      // Our own fill dispatches untrusted input events: only real typing counts.
      if (e.isTrusted && menu && e.target === menu.anchor) filterMenu();
    },
    true,
  );
  listen(window, "scroll", schedulePlace, { capture: true, passive: true });
  listen(window, "resize", schedulePlace, { passive: true });
  // A field focused before this script ran (autofocus on a sign-in page).
  maybeOpen(document.activeElement);
  // 2FA steps often appear without a page load (single-page sign-ins).
  scanForCodeField();
  let scanTimer = 0;
  const codeWatch = new MutationObserver(() => {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => alive() && scanForCodeField(), 400);
  });
  codeWatch.observe(document.documentElement, { childList: true, subtree: true });
  observers.push(codeWatch);
  // A menu opened on its own closes when the user clicks anywhere else.
  listen(
    document,
    "mousedown",
    (e) => {
      if (menu && e.target !== menu.anchor && !e.composedPath().includes(menu.host)) closeMenu();
    },
    true,
  );
}

// ─── The Minions button inside a field ───────────────────────────────────────
// A small logo at the right edge of a login, sign-up or 2FA field (focused or
// hovered). Clicking it opens the menu, even after the menu was closed.

const ICON_CSS = `
  :host{all:initial}
  button{all:unset;box-sizing:border-box;position:relative;display:block;width:22px;height:22px;border-radius:6px;cursor:pointer;
    box-shadow:0 0 0 1px rgba(0,0,0,.08),0 1px 3px rgba(0,0,0,.18);transition:transform .12s ease,opacity .12s ease;opacity:.92;animation:in .14s ease-out}
  button:hover{transform:scale(1.08);opacity:1}
  button:focus-visible{outline:2px solid rgba(99,102,241,.6);outline-offset:2px}
  @keyframes in{from{opacity:0;transform:scale(.8)}}
  svg{display:block;width:100%;height:100%;border-radius:6px}
  .n{position:absolute;top:-5px;right:-6px;min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;border-radius:999px;
    background:#10b981;color:#fff;font:700 9px/14px ui-sans-serif,system-ui,sans-serif;text-align:center;box-shadow:0 0 0 1.5px #fff}
  @media (prefers-reduced-motion:reduce){button{animation:none;transition:none}}
`;

interface FieldIcon {
  host: HTMLElement;
  button: HTMLButtonElement;
  count: HTMLElement;
  field: HTMLInputElement | null;
  kind: FieldKind | null;
}
let fieldIcon: FieldIcon | null = null;
let iconHideTimer = 0;

function ensureIcon(): FieldIcon {
  if (fieldIcon?.host.isConnected) return fieldIcon;
  const host = document.createElement("div");
  host.id = "minions-field-icon";
  host.style.cssText = "position:fixed;z-index:2147483646;top:0;left:0;display:none;";
  const root = host.attachShadow({ mode: "closed" });
  const button = document.createElement("button");
  button.type = "button";
  button.title = "Minions";
  button.setAttribute("aria-label", "Minions: fill this field");
  button.innerHTML = LOGO_SVG;
  const count = el("span", "n");
  count.hidden = true;
  button.append(count);
  const style = document.createElement("style");
  style.textContent = ICON_CSS;
  root.append(style, button);
  // Keep the focus in the field when the button is pressed.
  host.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", (e) => {
    if (!e.isTrusted || !fieldIcon?.field || !fieldIcon.kind) return;
    const { field, kind } = fieldIcon;
    // Asked for by the user: shown even if closed before or already noted.
    menuDismissed = false;
    noteShown = false;
    closeMenu();
    if (document.activeElement !== field) field.focus({ preventScroll: true });
    void openMenu(field, kind);
  });
  host.addEventListener("mouseenter", () => window.clearTimeout(iconHideTimer));
  host.addEventListener("mouseleave", () => scheduleIconHide());
  document.documentElement.appendChild(host);
  fieldIcon = { host, button, count, field: null, kind: null };
  return fieldIcon;
}

/**
 * Where the button goes: inside the field's right edge, moved left past
 * anything the site already put there (a show-password eye, a clear button).
 */
function placeIcon() {
  const icon = fieldIcon;
  const field = icon?.field;
  if (!icon || !field) return;
  const r = field.getBoundingClientRect();
  if (!field.isConnected || r.width < 80 || r.height < 18 || r.bottom < 0 || r.top > innerHeight)
    return hideIcon();
  const size = 22;
  const top = r.top + (r.height - size) / 2;
  icon.host.style.display = "none";
  let right = r.right - 8;
  for (let i = 0; i < 3; i++) {
    const hit = document.elementFromPoint(right - size / 2, r.top + r.height / 2);
    if (!hit || hit === field || hit.contains(field) || field.contains(hit)) break;
    right -= size + 8;
  }
  icon.host.style.display = "block";
  icon.host.style.transform = `translate(${Math.round(right - size)}px, ${Math.round(top)}px)`;
}

function hideIcon() {
  window.clearTimeout(iconHideTimer);
  if (fieldIcon) {
    fieldIcon.host.style.display = "none";
    fieldIcon.field = null;
  }
}

function scheduleIconHide() {
  window.clearTimeout(iconHideTimer);
  iconHideTimer = window.setTimeout(() => {
    const f = fieldIcon?.field;
    if (f && document.activeElement === f) return;
    hideIcon();
  }, 350);
}

async function showIcon(field: HTMLInputElement, kind: FieldKind) {
  window.clearTimeout(iconHideTimer);
  if (fieldIcon?.field === field) return placeIcon();
  const data = await inlineMatch();
  if (!data?.enabled || data.status === "signed-out") return;
  if (kind === "signup-email" && !data.emails.length) return;
  const icon = ensureIcon();
  icon.field = field;
  icon.kind = kind;
  // How many saved logins this site has, on sign-in fields.
  const n = kind === "login" && data.status === "unlocked" ? data.items.length : 0;
  icon.count.hidden = n === 0;
  icon.count.textContent = n > 9 ? "9+" : String(n);
  icon.button.title =
    kind === "new-password"
      ? "Minions: suggest a strong password"
      : kind === "otp"
        ? "Minions: fill the 2FA code"
        : kind === "signup-email"
          ? "Minions: fill your email"
          : data.status === "locked"
            ? "Minions is locked: click to unlock"
            : n
              ? `Minions: ${n} saved login${n === 1 ? "" : "s"} for this site`
              : "Minions";
  placeIcon();
}

if (!ON_APP) {
  const iconFor = (t: EventTarget | null) => {
    const kind = classify(t);
    if (kind) void showIcon(t as HTMLInputElement, kind);
  };
  listen(document, "focusin", (e) => iconFor(e.target), true);
  listen(
    document,
    "focusout",
    (e) => {
      if (e.target === fieldIcon?.field) scheduleIconHide();
    },
    true,
  );
  listen(
    document,
    "mouseover",
    (e) => {
      if (e.target instanceof HTMLInputElement) iconFor(e.target);
    },
    { capture: true, passive: true },
  );
  listen(
    document,
    "mouseout",
    (e) => {
      if (e.target === fieldIcon?.field && document.activeElement !== e.target) scheduleIconHide();
    },
    { capture: true, passive: true },
  );
  let iconFrame = 0;
  const follow = () => {
    if (!fieldIcon?.field || iconFrame) return;
    iconFrame = requestAnimationFrame(() => {
      iconFrame = 0;
      placeIcon();
    });
  };
  listen(window, "scroll", follow, { capture: true, passive: true });
  listen(window, "resize", follow, { passive: true });
  if (document.activeElement) iconFor(document.activeElement);
}

// ─── Fill requests from the background ───────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    msg: FillMessage | { type: "minions-bridge-hello" } | { type: "minions-show-save" },
    sender,
    sendResponse,
  ) => {
    if (sender.id !== chrome.runtime.id) return;
    // The background checking for a live copy before adding another.
    if ((msg as { type?: string })?.type === "minions-alive") {
      sendResponse(true);
      return;
    }
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
    closeMenu();
    if (username && msg.username) setValue(username, msg.username);
    if (password && msg.password) setValue(password, msg.password);
    sendResponse({ filled: !!((username && msg.username) || (password && msg.password)) });
  },
);

// ─── Ask before saving a login the user just submitted ───────────────────────

let lastReported = "";
let lastUsername = "";
/** The password field submitted on this page: its going away means the sign-in went through. */
let submittedField: HTMLInputElement | null = null;

function report() {
  // The master password typed into Minions itself is never a login to save.
  if (ON_APP) return;
  const s = submitted();
  if (!s) return reportUsernameStep();
  // Remember only that this pair was reported, not the password itself.
  const key = `${s.username}\u0000${s.password.length}:${s.password.slice(-1)}`;
  if (key === lastReported) return;
  lastReported = key;
  submittedField = s.field;
  void send({
    type: "formSubmitted",
    username: s.username.slice(0, 256),
    password: s.password.slice(0, 1024),
    fresh: s.fresh,
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

listen(
  document,
  "submit",
  (e) => {
    if (e.isTrusted) report();
  },
  true,
);
listen(
  document,
  "click",
  (e) => {
    if (!e.isTrusted) return;
    const t = e.target as HTMLElement | null;
    // Clicking back into a login field brings the menu back.
    if (!menu && document.activeElement === t) maybeOpen(t);
    const button = t?.closest("button, input[type=submit], input[type=button], [role=button]");
    if (button) report();
  },
  true,
);
listen(
  document,
  "keydown",
  (e) => {
    if (!e.isTrusted) return;
    if (menu && e.target === menu.anchor) {
      const n = menu.shown.length;
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
        void choose(menu.shown[menu.active]!);
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
  .done{display:flex;align-items:center;gap:10px;padding:12px 10px 12px 14px;font-weight:600}
  .done .titles .sub{font-weight:400}
  .done .ok{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:999px;background:#10b981;color:#fff}
  .err{padding:8px 14px 0}
  button.b[disabled]{opacity:.55;cursor:default}
`;

/** Waits up to a few seconds for the submitted form to go away (the sign-in worked). */
async function formGone(field: HTMLInputElement) {
  for (let i = 0; i < 14; i++) {
    if (!field.isConnected || !visible(field)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let prompting = false;

async function showPrompt() {
  if (ON_APP || prompting || document.getElementById("minions-save-prompt")) return;
  prompting = true;
  try {
    const pending = await send<PendingSave>({ type: "pendingSave" });
    if (!pending) return;
    if (pending.auto) {
      // Saved on its own once the sign-in went through: on a new page, or the
      // form gone from this one. Still on the form (wrong password?): ask.
      const field = submittedField;
      if (!field || (await formGone(field))) return await autoSave(pending);
    }
    askToSave(pending);
  } finally {
    prompting = false;
  }
}

function toastHost() {
  const { host, root } = overlay("minions-save-prompt", PROMPT_CSS);
  host.style.top = "16px";
  host.style.left = "auto";
  host.style.right = "16px";
  return { host, root };
}

/** Saves without asking, then says so with an Undo for a few seconds. */
async function autoSave(pending: PendingSave) {
  const isUpdate = !!pending.updateItemId;
  const r = await call<string | null>({
    type: "resolveSave",
    id: pending.id,
    action: isUpdate ? "update" : "save",
  });
  // Another page of this tab got there first, or it failed: ask instead.
  if (!r?.ok) return askToSave(pending, r?.error);
  if (r.data !== "saved" && r.data !== "updated") return;
  matchCache = null;
  const { host, root } = toastHost();
  const undo = el("button", "b ghost", "Undo");
  undo.type = "button";
  const close = el("button", "x", "×");
  close.setAttribute("aria-label", "Close");
  const card = el(
    "div",
    "card prompt",
    el(
      "div",
      "done",
      svg(CHECK_SVG, "ok"),
      el(
        "div",
        "titles",
        el("div", "title trunc", isUpdate ? "Password updated in Minions" : "Saved to Minions"),
        el(
          "div",
          "sub trunc",
          `${pending.host}${pending.username ? ` · ${pending.username}` : ""}`,
        ),
      ),
      undo,
      close,
    ),
  );
  card.setAttribute("role", "status");
  root.append(card);
  let timer = 0;
  const remove = () => {
    window.clearTimeout(timer);
    card.classList.add("out");
    setTimeout(() => host.remove(), 220);
  };
  const later = (ms: number) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(remove, ms);
  };
  card.addEventListener("mouseenter", () => window.clearTimeout(timer));
  card.addEventListener("mouseleave", () => later(4000));
  later(8000);
  close.addEventListener("click", (e) => e.isTrusted && remove());
  undo.addEventListener("click", async (e) => {
    if (!e.isTrusted) return;
    undo.disabled = true;
    const u = await call<string>({ type: "undoSave", id: pending.id });
    matchCache = null;
    const title = card.querySelector(".title");
    if (title)
      title.textContent = u?.ok
        ? u.data === "removed"
          ? "Removed from Minions"
          : "Old password put back"
        : (u?.error ?? "Could not undo");
    undo.remove();
    later(2200);
  });
}

function askToSave(pending: PendingSave, error?: string) {
  if (document.getElementById("minions-save-prompt")) return;
  const { host, root } = toastHost();
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
  if (error) card.insertBefore(el("div", "err", error), card.querySelector(".row"));
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
    // Left behind by an extension reload: the live copy answers, not this one.
    if (!chrome.runtime?.id) return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || d.source !== FROM_APP) return;
    if (d.type === "ping") void hello();
    else if (d.type === "unlock-me") {
      // The app is locked: hand it the keys if this extension is unlocked for the same account.
      void call<Record<string, unknown>>({
        type: "bridgeUnlockApp",
        nonce: d.nonce,
        userId: d.userId,
      } as Request).then((r) =>
        toApp(r?.ok ? { type: "keys", ok: true, ...r.data } : { type: "keys", ok: false }),
      );
    } else if (d.type === "lock") void send({ type: "bridgeLock" });
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
