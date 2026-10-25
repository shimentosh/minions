# Minions architecture

Minions is a private vault for credentials, secrets, financial records and notes.
It is an independent product. Its UI takes its visual language (tokens, Geist
type, sidebar-inset shell, coss-ui/Base UI primitives) from `J:\teamos\apps\web`;
nothing else from that product is used, imported or connected.

```
apps/
  api/        NestJS 11 + Prisma 7 + PostgreSQL 17 (REST, cookie or bearer sessions)
  web/        Vite + React 19 + TanStack Router/Query + Tailwind v4 (also the Tauri UI)
  extension/  Chrome MV3 extension (TypeScript, esbuild)
  desktop/    Tauri 2 shell that loads the web build
packages/
  core/       Shared, dependency-light TypeScript used by every app:
              crypto, item type registry, TOTP, password generator,
              strength estimation, secret detection, quick-capture rules,
              import parsers, URL matching
```

## 1. Encryption boundaries

End-to-end encrypted: the server never receives the master password or any key
that can decrypt vault data. Metadata (names, usernames, hosts, tags) is not
encrypted, and an actively compromised server could serve a modified web app;
see [THREAT_MODEL.md](THREAT_MODEL.md) for exactly what this does and does not
protect.

The exception is **email reset** (on by default, off in Settings → Security):
after an unlock the client sends the raw user key once, the server checks it
opens the vault key, and stores it as `serverEncrypt(userKey, "user:<id>:recovery")`
in `users.recoveryKeyEnc`. A reset link (`/reset-password#token`) returns it
after the second factor, and the page wraps it under a new master password,
as a backup code does. Turning email reset off deletes the copy. Every
account gets a link either way: the page can also start fresh
(`/auth/reset/start-over`), where the client makes new keys and an empty vault
and the server deletes the old vault and ends workspace memberships in the same
transaction that spends the link.

```
master password ──Argon2id(salt, m=64MiB, t=3, p=1)──► masterKey (32B, client only)
masterKey ──HKDF("minions/auth")──► authKey   → sent at login, server stores Argon2id(authKey)
masterKey ──HKDF("minions/enc")───► stretchedKey (client only)

userKey   (random 256-bit)  stored as AES-GCM(stretchedKey, userKey)      users.protected_user_key
vaultKey  (random 256-bit)  stored as AES-GCM(userKey, vaultKey)          vaults.protected_key
field     AES-256-GCM(vaultKey, value, AAD = "item:<id>:<fieldKey>")      vault_item_fields.value
note body AES-256-GCM(vaultKey, html,  AAD = "note:<id>:content")         notes.content_enc
fingerprintKey = HKDF(vaultKey, "minions/fingerprint")
  password fingerprint = HMAC-SHA256(fingerprintKey, password)            reuse detection only

pageKey   (random 256-bit, one per page)
          stored as AES-GCM(vaultKey, pageKey, AAD = "vault:<vid>:page:<id>:key")  pages.protected_key
page meta    AES-GCM(pageKey, {title, icon, props}, AAD = "page:<id>:meta")      pages.meta_enc
page content AES-GCM(pageKey, {v, doc|schema},    AAD = "page:<id>:content")    pages.content_enc
page file    0x01 ‖ iv ‖ AES-GCM(pageKey, bytes,  AAD = "page:<id>:file:<fid>") page_files.data
```

* Envelope format: `v1.<base64 iv>.<base64 ciphertext+tag>`. The server rejects a
  sensitive field whose value is not a well-formed envelope, so a buggy client
  cannot store plaintext secrets.
* AAD binds each ciphertext to its item and field. Swapping ciphertexts between
  fields or items fails authentication.
* Item ids are client-generated UUIDs so the AAD can be computed before the
  first save.
* Keys live only in memory (web: module scope; extension: `chrome.storage.session`,
  which never touches disk). Nothing decrypted is persisted in browser storage.
* The server keeps one key of its own, `SERVER_ENCRYPTION_KEY`, for data the server
  itself must read: the account TOTP secret. That key is not used for vault data.

### What the server can see (safe metadata)

Item name, type, description, URL host, username/email, provider, environment,
status, expiry and rotation dates, project, collection, tags, relations, access
counters. Also derived, deliberately coarse signals: password strength score
(0–4), whether a TOTP field exists, password last-changed date, and the keyed
password fingerprint (reveals only *equality* between the user's own passwords).
Card items expose only the last 4 digits and brand.

Everything else (passwords, keys, secrets, card numbers, CVV, account numbers,
TOTP secrets, recovery codes, private keys, connection strings, note bodies) is
ciphertext.

**Pages are stricter** (§10): their titles, icons, content, database schemas and
property values, and file names, types and bytes are all ciphertext. The server
sees only the tree's shape (parent ids), sibling order keys, page or database,
the favorite flag, times, revisions and sizes.

## 2. Authentication vs vault unlock

```
prelogin(email) → kdf params
login(email, authKey, device) → session (state PENDING_2FA if 2FA on)
2fa/verify(code | recovery code) → session ACTIVE
vault/kdf → kdf params (all a locked session gets)
vault/unlock(authKey) → wrapped keys; session.vault_unlocked_until = now + autoLock

backup-codes(authKey, [proof, user key wrapped by the code]) → replaces the set
recover/check(email, proof) → userId, user key wrapped by the code, whether 2FA is needed
recover/complete(email, proof, [code], new authKey, kdf, re-wrapped user key, device)
  → code spent, other sessions revoked, session ACTIVE; the vault is unchanged
```

* Session tokens: 256-bit random, only the SHA-256 is stored. Web uses an
  `HttpOnly; SameSite=Strict` cookie (+ `X-Minions-Client` header required on
  every request as CSRF defence); extension/desktop send `Authorization: Bearer`.
* Endpoints that return ciphertext of secret fields require an **unlocked**
  session (`VaultUnlockedGuard`). The unlock window slides with activity and is
  bounded by the user's auto-lock setting. The client also wipes its keys on lock.
* Brute force: global throttling, stricter throttles on auth routes, and one
  per-account failure counter (atomic increment) fed by wrong master passwords
  at sign-in and unlock and by wrong TOTP codes or passkeys. Every fifth
  failure in a row locks the account, for 1, 5, 15, then 60 minutes; the
  error says how long. Backup codes (100 random bits) are not counted, so
  they still work while sign-in is locked. The counter is
  cleared only after a *complete* sign-in, so knowing the password does not
  reset it between 2FA guesses. Constant-shape prelogin responses for unknown
  emails (deterministic fake salt).
* Second factors are single use: a TOTP time step is accepted once
  (`users.lastTotpStep`, compare-and-set), and recovery codes and WebAuthn
  challenges are consumed by conditional UPDATEs, so racing requests cannot
  reuse them.
* Wrapped keys (`/vault/keys`) are returned only to an unlocked session, so a
  stolen session token yields no material for offline guessing.
* In production the session cookie is `__Host-minions_session` (Secure,
  Path=/, no Domain), and the API refuses to start with development secrets,
  non-https origins or a reused server key.
* Emergency lock revokes every session of the user, including the caller's.
* Email ownership: sign-up sends a single-use link (`/verify-email#<token>`,
  Resend API, SHA-256 stored, 24 h). Until it is opened, the address is only a
  claim: workspace invitations to it are hidden and cannot be accepted.
* Vault-key rotation (`/vault/rotation/*`): the client wraps a new random vault
  key under the user key and starts a rotation (master password required). The
  server stores it as `vaults.pending_protected_key`, locks other sessions and
  refuses other writes. The client pulls rows still under the old key
  generation, re-encrypts fields, history, note bodies and fingerprints, and
  posts them back; the server checks every secret is an envelope and bumps each
  row's `key_gen`. When none are left, `finish` swaps the wrapped key. Any
  unlock while a rotation is pending returns both wrapped keys, and the web
  client finishes it.

## 3. Data model (PostgreSQL, Prisma)

users, vaults, recovery_codes, webauthn_credentials (pending integration),
devices, sessions, projects, collections, tags, vault_items, vault_item_fields,
vault_item_versions, vault_item_tags, vault_item_relations, item_project_links,
notes, note_versions, note_tags, pages, page_versions, page_files,
activity_logs, security_events,
security_finding_states, ai_classifications, user_classification_preferences,
import_jobs, import_items.

Item types are strings validated against the registry in `@minions/core`, not a
database enum, so a new type is a registry entry plus UI, with no migration.

## 4. API modules

auth, users, vault, vault-items, projects, collections, tags, relations, notes,
pages, activity, security, devices, sessions, imports, ai, common (prisma,
guards, throttling, server crypto, request context).

Password generation, TOTP code generation, import parsing and quick-capture
secret extraction run on the client, because the server must never see the values.

## 5. AI (DeepSeek)

`POST /ai/classify` accepts only a whitelisted metadata shape (type hint, provider,
host, name, project/environment hints, free text). The server runs
`sanitizeForAi()` (redacts anything resembling a key, token, card number, IBAN,
password assignment, private key, high-entropy string) before building the
prompt. Financial types never reach the AI at all. Without `DEEPSEEK_API_KEY` the
endpoint reports `unavailable` and the rule engine result stands.

Pipeline: rules → learned user preferences → AI (if still uncertain) →
confidence banding (≥0.85 auto-apply suggestion, ≥0.6 ask, else manual).
Corrections update `user_classification_preferences`.

## 6. Search

Server-side search runs over safe metadata only (`search_text` + pg_trgm GIN
index, joined with project/collection/tag names). Ciphertext is never searched.
Note titles are searchable; note bodies are encrypted and are not.

Page titles are encrypted too, so page search runs on the device: the client
loads the whole tree after unlock (one request), decrypts every title in memory
and filters it there. Nothing decrypted is persisted.

## 7. Workspaces and sharing

Teams share credentials without the server ever holding a key that opens one.

```
user key pair    RSA-OAEP-3072 / SHA-256, created on the client at first unlock
                 users.public_key (SPKI), users.protected_private_key = AES-GCM(userKey, PKCS#8,
                 AAD "user:<id>:private-key")
workspace key    random 256-bit; sealed to each confirmed member:
                 workspace_members.protected_workspace_key = RSA-OAEP(pub, key, label "workspace:<wid>:key:<uid>")
item key         random 256-bit per workspace item; fields AES-GCM under it (same AAD as personal items)
grant            workspace_item_grants.protected_item_key = RSA-OAEP(pub, itemKey, label "item:<id>:key:<uid>")
"everyone"       vault_items.protected_item_key = AES-GCM(workspaceKey, itemKey,
                 AAD "workspace:<wid>:item:<id>:key")
```

* OAEP labels and AAD bind every wrapped key to its item, workspace and recipient,
  so the server cannot move a key to another row or person.
* A workspace owns one `vaults` row (`user_id` null). Workspace items are ordinary
  `vault_items` in it, so storage, field validation (`PLAINTEXT_SECRET`), history and
  metadata search are the personal vault's code, run after the workspace module has
  authorised the caller (`apps/api/src/workspaces/access.ts`).
* Access to an item: an explicit grant (VIEW or MANAGE), or "everyone confirmed in
  the workspace". Owners and admins manage what they can open, and cannot open what
  is neither granted to them nor shared with everyone. Favorites are per person.
* Joining: an admin invites an email; the person accepts (their public key is now
  visible to admins); an admin confirms, which seals the workspace key to them on the
  admin's device. The confirm dialog shows the member's key fingerprint to compare out
  of band, which is the defence against a server substituting a public key.
* Revoking: server access ends in the same transaction. Keys cannot be taken back, so
  affected items get `rekey_needed`, and so does the workspace key when the person held
  it. A manager's client rotates an item key (fields re-encrypted, every grant re-sealed,
  old versions dropped) and an admin's client rotates the workspace key (re-sealed to
  every member, every shared item re-wrapped), each in one transaction.
* Items only the removed person could open are deleted: nobody else holds their key.
* Audit: `activity_logs.workspace_id`. Owners and admins read the whole workspace log;
  members read their own entries; item managers read who used that item. Other
  people's IP addresses and device names are not shown, only the client kind.
* Extension: `/workspaces/items/match` and `/search` cover every workspace the user is
  confirmed in, with the same public-suffix-aware matching as personal items. The
  private key is held in `chrome.storage.session` next to the vault key.

## 8. Sharing items with people

A personal item can be shared by email (`apps/api/src/people-sharing`,
`apps/web/src/lib/people-sharing.ts`). Same primitives as workspaces, no workspace.

- **Own key on first share.** The client generates an item key, re-encrypts every
  secret field and every version under it (same AAD), and wraps it with the vault key
  (`keyAad.itemKeyForVault`) into `vault_items.protectedItemKey`. The server checks, as
  in rotation, that every secret comes back as an envelope. Unshared items are unchanged.
- **Recipients.** `item_shares` holds one row per (item, email). For a verified account
  with a key pair the client seals the item key at once (`sealContext.itemKey`). Anyone
  else is emailed an invitation (`/register?email=`) and the row waits; once that address
  is verified and has keys, the owner's client completes the seal on its next open
  (`/people-shares/pending-seals`). Nothing reaches an unverified address.
- **Recipient view.** `/shared` and `/shared/items/:id`: fields and the sealed key only;
  no project, collection, tags, history or relations. `EDIT` permission may change fields,
  name and description; the owner's filing is kept and the edit is logged for the owner.
- **Expiry and removal.** Optional `expiresAt` (or never). Removing someone, or them
  leaving, deletes the row and flags the item; the owner's client re-keys it right away
  and re-seals to everyone who keeps access.
- **Rotation, backup, extension.** Vault-key rotation re-wraps the item key and leaves
  the fields alone; encrypted backups include `protectedItemKey`; the extension opens it.
- **Known limits.** `GET /people-shares/lookup` tells a verified, unlocked user whether
  an address has a verified account (rate limited). The server could substitute a public
  key; the security code shown next to the recipient is the check.

## 9. Operator dashboard

`/operator` (API `apps/api/src/operator`) shows how the service is used: accounts,
sign-ups per day, active accounts, items by type, imports by source, workspaces and
devices, plus a list of accounts (email, name, joined, last active, counts). It holds
no item names, hosts, IPs or ciphertext. Access requires the account's id in
`OPERATOR_USER_IDS` (ids, because email ownership is never verified), an unlocked vault and, outside development, two-factor; everyone
else gets 404. Each view is recorded in the operator's activity log.

## 10. Pages (Notion-style)

Plan and roadmap: [docs/NOTION_ALTERNATIVE_PLAN.md](docs/NOTION_ALTERNATIVE_PLAN.md).
API `apps/api/src/pages`, client `apps/web/src/lib/pages`, importer `apps/web/src/lib/notion`.

- **A key per page.** Each page has a random key wrapped by the vault key
  (`pageAad.key`). Title, icon and database row properties (`meta_enc`), the editor
  document or database schema (`content_enc`) and files (`page_files`) are under it,
  with AAD naming the page and file, so nothing can be swapped between pages. The
  server refuses anything that is not an envelope (`PLAINTEXT_SECRET`) or, for files,
  an encrypted blob.
- **Tree.** `pages.parent_id` (same vault, checked), `position` (fractional index),
  `kind` (`page` or `database`; a database's rows are its child pages). Moves are
  refused if they would make a cycle. Deleting stamps a page and every live
  descendant with one `deleted_at`; restoring brings back exactly that group (a page
  whose parent is still in the trash comes back at the top level); purging deletes the
  sub-tree with its versions and files.
- **Content.** ProseMirror JSON in the editor schema (`lib/pages/schema.ts`: Tiptap
  StarterKit, to-dos, tables, toggles, callouts, encrypted images and files, page
  links by id, vault-item chips). Images and files have no `src`: the client fetches
  ciphertext, decrypts it and shows a `blob:` URL, so a page cannot make the browser
  load anything remote. Saves are revision-checked; a version is kept at most every
  10 minutes.
- **Rotation and backup.** Vault-key rotation re-wraps page keys (batch kind
  `pages`); `finish` refuses while any page is left. The encrypted export includes
  pages; restore re-wraps their keys (and re-encrypts for a fresh id when restoring
  into another account). Files are not in backups yet.
- **Files.** `PUT /pages/:id/files/:fileId` takes raw ciphertext
  (`application/octet-stream`, 25 MiB plus header; nginx allows 26 MB on that route
  only) with the encrypted `{name, type}` in `X-Minions-File-Meta`. Stored in
  PostgreSQL `bytea`.
- **Archive.** Pages and vault items have a plaintext `archived_at` (like `favorite`,
  an organising flag). Archiving a page archives everything under it; unarchiving
  brings back the page, everything under it and the pages above it
  (`POST /pages/archive`). The tree carries `archivedAt` and the client hides archived
  pages and their sub-pages from the sidebar and page search; item lists and the
  palette leave archived items out unless `?archived=include|only`, and say how many
  they hid. One "Show archived" switch per device (`lib/archive.ts`, a yes/no in
  `localStorage`). Autofill, opening an item and the Security Center still see
  archived items. Backups keep the state.
- **Search.** Titles are searched in memory from the tree. Content search
  (`lib/pages/search.ts`) asks `POST /pages/contents` for up to 100 encrypted bodies at
  a time (at most ~4 MB per response; the rest come back as ids to ask for again),
  decrypts them on the device and keeps a MiniSearch index in memory only, dropped on
  lock. A page is fetched again only when its revision changes. The server sees which
  ids are asked for, never the query. ⌘K and the Pages list search titles and content.
- **Favorites** are the plaintext `favorite` flag (`PATCH /pages/:id`). The client
  shows the change before the request returns and undoes it if the request fails.
- **Notion import** runs on the device: zip.js reads the export in place (parts and
  nested zips too), Markdown/HTML go through DOMPurify and the editor schema,
  databases come from the CSV (or the HTML table), and credentials found in pages,
  tables, code blocks and credential databases become vault items through `/imports`,
  leaving a chip in the page. Sub-page folders are matched by `<Title> <id>`, or by
  title or id alone as newer exports write them; CSV rows pair with row pages by
  title, loosely when file names lost characters. Credential labels may name a
  service ("Gmail password") or a role ("Admin password"), share a line, sit above
  their value or fill a two-column table. The same secret for the same account found
  twice becomes one item (`dedupeKey`), which every page links to; item notes record
  the Notion path. By default everything created is archived: pages with
  `{from: "notion", at}` in their encrypted meta, items tagged `notion-import`. Pages
  are written parents-first in batches of up to 100 (`POST /pages/batch`,
  idempotent), files one at a time; both retry through rate limits. Nothing is sent
  before the person confirms the preview. `src/lib/notion/export-stats.test.ts` runs
  the import's read and convert steps on a real export (`NOTION_EXPORT=…`) and prints
  aggregate counts only.
- **Not yet:** pages in team workspaces and sharing a page (phase 3), full-text search
  of content (phase 2).
