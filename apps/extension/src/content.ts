/**
 * Runs on web pages, top frame only. It never sees the vault key and never
 * reads the vault: it fills the one credential the user picked in the popup,
 * and reports a login form submission so the background can ask whether to
 * save it. Nothing is saved without the user pressing Save.
 */
import type { FillMessage, PendingSave, Request, Response, SaveAction } from "./messages";

function send<T>(req: Request): Promise<T | null> {
  return chrome.runtime
    .sendMessage(req)
    .then((r: Response<T>) => (r?.ok ? r.data : null))
    .catch(() => null);
}

function visible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

function findFields(root: ParentNode = document) {
  const password =
    [...root.querySelectorAll<HTMLInputElement>('input[type="password"]')].find(visible) ?? null;
  const scope: ParentNode = password?.form ?? document;
  const candidates = [
    ...scope.querySelectorAll<HTMLInputElement>(
      'input[type="email"], input[type="text"], input:not([type])',
    ),
  ].filter((i) => visible(i) && i !== password);
  const score = (i: HTMLInputElement) => {
    const hay =
      `${i.name} ${i.id} ${i.autocomplete} ${i.placeholder} ${i.getAttribute("aria-label") ?? ""}`.toLowerCase();
    return (/user|email|login|account|identifier/.test(hay) ? 2 : 0) + (i.type === "email" ? 1 : 0);
  };
  // Prefer a likely username field that comes before the password field.
  const before = candidates.filter(
    (c) => !password || c.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const username = [...before].sort((a, b) => score(b) - score(a))[0] ?? null;
  return { username, password };
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

chrome.runtime.onMessage.addListener((msg: FillMessage, sender, sendResponse) => {
  // Only the extension itself may ask for a fill, and only into the top frame.
  if (sender.id !== chrome.runtime.id || msg?.type !== "minions-fill") return;
  // The background checked the tab's address before decrypting; if the page
  // navigated since, it is a different origin now and gets nothing.
  if (window.top !== window || location.origin !== msg.origin) {
    sendResponse({ filled: false });
    return;
  }
  const { username, password } = findFields();
  if (username && msg.username) setValue(username, msg.username);
  if (password && msg.password) setValue(password, msg.password);
  sendResponse({ filled: !!(username || password) });
});

// ─── Ask before saving a login the user just submitted ───────────────────────

let lastReported = "";
function report() {
  const { username, password } = findFields();
  if (!password?.value) return;
  // Remember only that this pair was reported, not the password itself.
  const key = `${username?.value ?? ""}\u0000${password.value.length}:${password.value.slice(-1)}`;
  if (key === lastReported) return;
  lastReported = key;
  void send({
    type: "formSubmitted",
    username: (username?.value ?? "").slice(0, 256),
    password: password.value.slice(0, 1024),
  }).then(() => setTimeout(showPrompt, 300));
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
    const el = (e.target as HTMLElement | null)?.closest(
      "button, input[type=submit], [role=button]",
    );
    if (el && findFields().password?.value) report();
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    if (e.isTrusted && e.key === "Enter" && (e.target as HTMLElement | null)?.tagName === "INPUT")
      report();
  },
  true,
);

async function showPrompt() {
  const pending = await send<PendingSave>({ type: "pendingSave" });
  if (!pending || document.getElementById("minions-save-prompt")) return;
  const host = document.createElement("div");
  host.id = "minions-save-prompt";
  host.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;";
  // A closed shadow root keeps page scripts and styles out of the prompt.
  const root = host.attachShadow({ mode: "closed" });
  const isUpdate = !!pending.updateItemId;
  root.innerHTML = `
    <style>
      .card{font:13px/1.4 ui-sans-serif,system-ui,sans-serif;width:320px;background:#fff;color:#262626;border:1px solid rgba(0,0,0,.08);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.12);padding:14px}
      @media (prefers-color-scheme:dark){.card{background:#1c1c1c;color:#f5f5f5;border-color:rgba(255,255,255,.08)}.muted{color:#a3a3a3}.ghost{color:#f5f5f5}}
      .title{font-weight:600;font-size:14px;margin-bottom:2px}
      .muted{color:#737373;word-break:break-all}
      .row{display:flex;gap:6px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap}
      button{font:inherit;border-radius:8px;padding:6px 10px;cursor:pointer;border:1px solid transparent}
      .primary{background:#262626;color:#fafafa}
      .ghost{background:transparent;color:#262626}
    </style>
    <div class="card" role="dialog" aria-label="Save to Minions">
      <div class="title"></div>
      <div class="muted host"></div>
      <div class="row">
        <button class="ghost" data-a="ignore">Cancel</button>
        <button class="ghost" data-a="never">Never for this site</button>
        <button class="primary" data-a="${isUpdate ? "update" : "save"}">${isUpdate ? "Update" : "Save"}</button>
      </div>
    </div>`;
  // Text set via textContent: page-controlled strings never become markup.
  root.querySelector(".title")!.textContent = isUpdate
    ? `Update password for ${pending.updateItemName}?`
    : "Save this login?";
  root.querySelector(".host")!.textContent =
    `${pending.host}${pending.username ? ` · ${pending.username}` : ""}`;
  root.addEventListener("click", async (e) => {
    // A page script cannot press these for the user: synthetic clicks are ignored.
    if (!e.isTrusted) return;
    const action = (e.target as HTMLElement).dataset.a as SaveAction | undefined;
    if (!action) return;
    await send({ type: "resolveSave", id: pending.id, action });
    host.remove();
  });
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 60_000);
}

// A full-page navigation after login lands here: show any pending prompt.
void showPrompt();
