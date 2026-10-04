# Minions

A private, end-to-end encrypted vault for logins, API keys, server and
database credentials, environment variables, 2FA secrets, cards, bank
accounts, licenses and notes, with a web app, a Chrome extension and a Tauri
desktop shell.

The UI takes its visual language from `J:\teamos\apps\web` (Geist type, neutral
tokens, inset sidebar shell, coss-ui/Base UI primitives). Nothing else from
that product is used: Minions has its own API, database, auth and crypto.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and encryption
boundaries, and [SECURITY.md](SECURITY.md) for what has been verified.

## Layout

```
apps/api         NestJS 11 + Prisma 7 + PostgreSQL 17
apps/web         Vite + React 19 + TanStack Router/Query + Tailwind v4
apps/extension   Chrome MV3 extension (esbuild)
apps/desktop     Tauri 2 shell around the web build
packages/core    Crypto, item types, TOTP, generator, detection, classification, import parsers
tests/e2e        Browser tests for the web app and the extension (Playwright)
```

## Run it

Requirements: Node 22.12+, pnpm 11, Docker. Rust is needed only for the desktop app.

```bash
pnpm install
pnpm db:up                                  # minions-postgres on :55440
cp apps/api/.env.example apps/api/.env      # then fill SERVER_ENCRYPTION_KEY and PRELOGIN_SECRET
cp apps/web/.env.example apps/web/.env
pnpm --filter @minions/core build
pnpm --filter @minions/api db:deploy        # apply migrations
pnpm dev                                    # API on :4600, web on :5180
```

Generate the two server keys with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
Set `DEEPSEEK_API_KEY` to enable AI suggestions; without it, rules and learned
preferences are used. Set `RESEND_API_KEY` and `MAIL_FROM` to send email
verification links through [Resend](https://resend.com); without them, development
skips sending (and production refuses to start).

**Chrome extension:** `pnpm --filter @minions/extension build`, then
chrome://extensions → Developer mode → Load unpacked → `apps/extension/dist`.
`MINIONS_API_URL` / `MINIONS_WEB_URL` at build time point it elsewhere.

**Desktop:** `pnpm --filter @minions/desktop dev` (runs the web dev server inside a
Tauri window). For a different API origin, update `connect-src` in
`apps/desktop/src-tauri/tauri.conf.json`.

## Test

```bash
pnpm --filter @minions/core test     # crypto, TOTP vectors, detection, classification, imports
pnpm --filter @minions/api test      # integration tests against minions_test (created automatically)
pnpm typecheck
pnpm lint
node tests/e2e/smoke.mjs             # needs `pnpm dev` running
pnpm --filter @minions/extension build && node tests/e2e/extension.mjs
```

## Status by phase

| Phase | State |
|---|---|
| 1 Foundation | Done. Monorepo, API, DB schema and migrations, auth, vault and encryption architecture, web shell. |
| 2 Core vault | Done. Generic items with a type registry, projects, collections, tags, search, favorites, trash. |
| 3 Security | Done. Account 2FA (TOTP + recovery codes), sessions, devices, revocation, emergency lock, auto-lock (client and server), activity, security events, Security Center. |
| 4 Intelligence | Done. Rules → learned preferences → DeepSeek pipeline with confidence bands and corrections, duplicate detection with merge/link/keep separate, cleanup, "since your last visit", relationships, explainable score. |
| 5 Developer vault | Done. Server, SSH key, database, cloud, environment variables (.env paste), webhooks, domains. |
| 6 Personal | Done. Cards (masked, last 4 only in metadata), bank and payment accounts, licenses, secure notes. |
| 7 Notes | Done. Rich text (TipTap), encrypted bodies, pin/favorite/archive/trash, tags, projects, collections, version history. |
| 8 Extension | Done. Site matching, fill, save-on-submit and update-password prompts, search, generator, TOTP, quick save, independent lock. |
| 9 Desktop | Done. Release build with a Windows installer (`apps/desktop/src-tauri/target/release/bundle/nsis`), tested by driving the real window (`tests/e2e/desktop.mjs`). |
| 10 Migration | Done. Notion (CSV export), Chrome/Edge, Firefox, Bitwarden CSV/JSON, generic CSV/JSON, with preview, duplicate detection, account-family linking and confirmation. |

### Since the first version

- **Paste anything.** The new-item dialog reads whatever you paste (site, email, password, `label: value` lines, `.env`, card details, a 2FA QR screenshot) and fills the right fields, on the device.
- **Less retyping.** Fields offer values you've used before (registrar, provider, email…). A domain, server or payment account can **link** a saved login instead of copying its password. Several domains can be added at once, one per line, and **Save & add another** keeps the shared fields.
- **Authenticator.** Every 2FA code in one place, live, click to copy. Import QR screenshots, including Google Authenticator's *Transfer accounts* export.
- **Passkeys.** Windows Hello, Touch ID, a phone or a security key as the second factor at sign-in (Settings → Passkeys). The vault still opens with the master password.
- **Backup restore.** Settings → Backup → Restore: decrypts the backup on the device with its master password and re-encrypts it into the current vault; anything already present is skipped.
- **Scale.** Security Center results are precomputed per vault and refreshed in the background after changes. Measured at 100,000 items: ~370 ms per read, ~4 s for the very first build, search and lists under 250 ms (`node tests/bench/scale.mjs`).
- **Shared rate limits.** With `REDIS_URL` set (`docker compose up -d redis`), limits hold across several API instances.
- **Desktop sign-in remembered.** The desktop app keeps its session token in the OS credential store; after a restart the vault is locked until the master password is entered.

### Still open

- **DeepSeek live.** Verified over HTTP against a stand-in server. Add `DEEPSEEK_API_KEY` to `apps/api/.env` and run `pnpm --filter @minions/api ai:check` for a live call.
- **Passkeys in the desktop app.** WebView2 has no `https` origin there, so passkeys work in the browser only.
- **Passkey-only unlock.** Opening the vault without the master password needs the WebAuthn PRF extension; not built.
- **Backup history.** Restores items and notes, not their version history.

### Team workspaces

**Workspaces** (sidebar) → create one → **Members** → invite by email. The person signs in
with that email, opens Workspaces and presses **Join**; an owner or admin presses **Confirm**
after comparing the key fingerprint with them. Each credential is then **Only me**, shared
with **specific members** (can use / can manage) or with **everyone in the workspace**. A
member's profile lists the credentials they can open; **Activity** is the workspace audit log.
The extension fills team logins next to personal ones. Design: ARCHITECTURE.md §7.

### Operator dashboard

Put your account id in `OPERATOR_USER_IDS` (apps/api/.env; `SELECT id FROM users WHERE email = '…'`), restart the API, turn on two-factor
(not needed with `NODE_ENV=development`), then open **Tools → Operator**: sign-ups, active
accounts, imports, workspaces and an account list. No vault content is ever shown.

```bash
node tests/e2e/workspaces.mjs        # two browsers: invite, confirm, share, reveal, revoke, rotate
```
