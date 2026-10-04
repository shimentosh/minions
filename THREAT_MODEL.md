# Minions threat model

Scope: the code in this repository as of 2026-10-04 (API, web app, Chrome
extension, Tauri desktop shell, `@minions/core`). Design details are in
[ARCHITECTURE.md](ARCHITECTURE.md); test evidence is in [SECURITY.md](SECURITY.md).

**Summary.** Vault secrets (passwords, keys, card numbers, TOTP secrets, note
bodies…) are encrypted on the client under keys derived from the master
password, which the server never receives. A database dump or a passive server
compromise does not reveal them. It *does* reveal metadata: item names,
usernames/emails, hosts, tags, and activity. An **active** server compromise
can serve malicious JavaScript to the web app and capture the master password
at the next unlock. That is the limit of any browser-delivered end-to-end
encryption, and the reason it is not called "zero-knowledge" without that caveat.

## Assets

| Asset | Where it lives | Protection |
|---|---|---|
| Passwords, API keys, card numbers, CVV, TOTP secrets, private keys, note bodies | `vault_item_fields.value`, `vault_item_versions.fields`, `notes.content_enc`, shares | AES-256-GCM under the vault key, AAD bound to item+field. Server refuses plaintext in a sensitive field. |
| Master password | User's head, briefly in client memory | Never sent or stored. Argon2id (64 MiB, t=3) on the client. |
| Vault key / user key | Client memory only (web: module scope; extension: `chrome.storage.session`) | Wrapped (AES-GCM) by the user key / stretched master key. Wipe on lock. |
| Usernames, item names, hosts, tags, projects | Plaintext columns | Server-side authorization only. **Readable from a DB dump** (see R1). |
| Session tokens | Client: HttpOnly cookie (web), OS keychain (desktop), `chrome.storage.session` (extension) | 256-bit random; DB stores SHA-256 only; revocable; 30-day expiry. |
| Account TOTP secret | `users.twoFactorSecretEnc` | AES-GCM under `SERVER_ENCRYPTION_KEY`. Readable by whoever holds that key. |
| Recovery codes | `recovery_codes` | SHA-256 of 50-bit random codes, single use. |
| Audit logs | `activity_logs`, `security_events` | Metadata whitelist (ids, counts, labels); never values. Include IP and user agent. |

## Threat actors and what each can do

| Actor | Can | Cannot (and why) |
|---|---|---|
| **External attacker** (network, no account) | Hit public endpoints; guess passwords; probe ids | Brute-force: per-IP throttling plus per-account lockout (1→60 min, counter is atomic). Guessing ids: every query is scoped by the session's vault/user. TLS/HSTS required in production. |
| **Compromised user account** (attacker has the session token only) | See metadata endpoints that do not need unlock (`/auth/me`, sessions, devices, activity) | Read ciphertext or wrapped keys: those require a vault unlock with the master password (`VaultUnlockedGuard`, `/vault/keys` guarded). No offline-guessing material is exposed to a locked session. |
| **Compromised account** (attacker has the master password) | Everything the user can, unless 2FA is on | With 2FA: wrong codes count toward the account lockout across sign-ins, and codes cannot be replayed. Emergency lock and device revocation end every session at once. |
| **Malicious workspace member** | Open items granted to them or shared with everyone; copy what they can see | Open anything else: each item key is sealed to named members or wrapped by the workspace key; the server authorises every route from the session's membership, never the body (ARCHITECTURE.md §7). |
| **Removed workspace member** | Keep whatever they copied while they had access | Use the API again: memberships and grants are deleted in one transaction, so the next request (web, extension or desktop) gets 404. Future values: affected item keys and the workspace key are flagged and rotated by a manager's client. Change the password at the service too (R6). |
| **Operator (dashboard user)** | See every account's email, name, join date, activity dates and counts | See vault content, item names, hosts or IPs: none are in any operator response. Access needs the account-id allowlist, an unlocked vault and 2FA, and is audit-logged. |
| **Compromised browser / device** (malware, malicious extension with broad access) | Read the decrypted vault while it is unlocked, keylog the master password | Out of scope for software alone. Mitigations: short auto-lock, keys wiped on lock, nothing decrypted persisted. |
| **Database attacker** (dump, backup, snapshot) | Read metadata, wrapped keys, KDF salts, Argon2id(authKey) hashes, ciphertext, the encrypted account TOTP secret | Decrypt vault data: needs the master password. Offline guessing costs Argon2id 64 MiB per guess, twice (client KDF, then server hash of the auth key). TOTP secret needs `SERVER_ENCRYPTION_KEY`, which is not in the DB. |
| **Server attacker, passive** (reads memory, env, logs) | Everything the DB attacker can, plus `SERVER_ENCRYPTION_KEY` (account TOTP secrets) and live session tokens in transit | Decrypt the vault: the server never holds a key that can. |
| **Server attacker, active** (can change code or responses) | Serve modified web-app JavaScript that captures the master password; forge API responses; withhold or roll back data (AES-GCM AAD stops field swapping, not wholesale rollback) | Affect the extension or desktop app's code, which is packaged rather than fetched (it can still lie in API responses). See R2. |
| **Malicious website** | Run script next to the content script; fake login forms; try to trigger fills or saves | Get a fill: fill happens only on the user's click in the popup, only in the top frame, only if the page's host matches the saved one (Public Suffix List aware, compared in punycode), only https for https logins, and the content script re-checks its origin before filling. Synthetic clicks on the save prompt are ignored; content-script messages are shape-validated and limited to save prompts for their own host. |
| **Phishing / look-alike site** (`paypa1.com`, `xn--…`, `evil.co.uk`, `x.github.io`) | Show a convincing page | Receive credentials: different registrable domain → no match. Tested in `packages/core/src/url.test.ts` and `hardening.test.ts`. |
| **Malicious extension environment** (another extension, compromised Chrome profile) | Message our extension if it knows the id | Our background rejects any `sender.id` other than its own; `chrome.storage.session` is restricted to trusted contexts. A fully compromised browser is out of scope. |

## Attack surfaces and mitigations

| Surface | Main risks | Mitigations in place |
|---|---|---|
| Web app | XSS stealing in-memory keys; CSRF; data in storage/URLs | React escaping, no `dangerouslySetInnerHTML`; TipTap sanitises note HTML and restricts link protocols; CSP meta tag in builds (no inline/remote script); HttpOnly SameSite=Strict cookie plus a required custom header; only theme/sidebar/device-id in localStorage; share keys in the URL fragment, removed after reading. |
| API | IDOR/BOLA, injection, brute force, info leaks | Ids from the client are only looked up together with the session's vault/user id; DTO whitelisting (`forbidNonWhitelisted`) rejects smuggled `userId`/`vaultId`; Prisma parameterised queries (raw SQL only via tagged templates); throttling; `SafeExceptionFilter`; Helmet headers with `default-src 'none'`; `Cache-Control: no-store`. No server-side URL fetching (no SSRF surface); the only outbound call is DeepSeek, to a fixed configured base URL. |
| Authentication | Credential stuffing, 2FA bypass, replay | Argon2id twice; atomic lockout counter shared by password, unlock, TOTP and passkey failures, cleared only after full sign-in; TOTP time-step replay protection; single-use recovery codes and WebAuthn challenges via conditional UPDATE. |
| Sessions | Theft, fixation, lingering access | Random tokens hashed at rest; `__Host-` cookie in production; revocation of a session/device/all sessions takes effect on the next request; master-password change revokes other sessions. |
| Database / backups | Dump reveals data | Secrets are ciphertext in every table and every backup or snapshot; the vault export is the same ciphertext plus wrapped keys. There is no unencrypted export endpoint. |
| Logs | Secrets in logs | Activity metadata whitelist; usage `field` must look like a field key; error filter logs only error class and code; Prisma query logging off. |
| Chrome extension | Over-broad permissions, message spoofing, wrong-origin fill, clipboard residue | MV3; permissions: `storage`, `activeTab`, `alarms`, `offscreen`, `clipboardWrite`; host permission only for the API origin; content script on https pages and localhost, top frame only (needed to detect login submissions and offer "Save this login?"); strict extension CSP (`'wasm-unsafe-eval'` only for Argon2); no remote code or eval; clipboard cleared after 30 s by an offscreen document even when the popup is closed. |
| Autofill | Lookalike, homograph, iframe, http downgrade | `canFill()` in `@minions/core`; top-frame-only messaging with an origin re-check in the content script; no automatic fill on page load. |
| Password saving | Silent upload, page-forged saves | Nothing uploads before Save is pressed; prompt offers Save / Never for this site / Cancel; host taken from the browser (`sender.url`), not the page; pending login expires after 5 min and is cleared on lock. |
| Desktop | Token theft | Token in the OS credential store; Tauri `core:default` only, frozen prototype, CSP. |
| Team workspaces | Cross-workspace access, removed members, server key substitution | Membership resolved from the session on every route; per-item and workspace keys sealed per member; revocation in one transaction plus re-keying; fingerprint comparison at confirm (R6). |
| Operator dashboard | Exposure of the account list (emails, names, activity dates) | Allowlist + unlocked vault + 2FA, 404 for everyone else, every view audit-logged, no vault content. Allowlist is by account id, because emails are unverified (R11). |
| Email verification | Account squatting on someone else's address, link theft | Single-use hashed token in the URL fragment (not sent to servers or logs), 24 h expiry, atomic use, throttled; invitations need a verified address. |
| Key rotation | Plaintext or dropped secrets, mixed keys | Server requires every sensitive field and history entry back as an envelope; other writes and exports are refused until the swap; per-row key generation makes resume and retries safe. |

## Residual risks and open decisions

These were not changed because each needs a product decision or is a known
limit. They are listed so nobody mistakes them for solved.

- **R1. Usernames, hosts and other metadata are plaintext: accepted for now.**
  A DB dump reveals item names, usernames/emails, hosts, tags, project names and
  activity (not passwords or any other secret). Decision (2026-10-04): keep them
  readable to the server for now. Encrypting them would remove partial search by
  domain or username for personal and team items, move site matching and
  duplicate detection to keyed blind indexes (exact match only), and need
  re-indexing whenever a workspace key is rotated after a member leaves. That
  is a large change to a just-tested team feature for a moderate gain.
  Compensating controls: no unencrypted export; database access limited to the
  API; backups must be encrypted at rest (SECURITY.md, Deployment); the
  operator dashboard shows no item metadata. Upgrade path when this is
  revisited: make identity/location fields sensitive in the item registry and
  add blind indexes `HMAC(HKDF(vaultKey or workspaceKey, "minions/index"), value)`
  for host, registrable domain and username.
- **R2. Active server compromise defeats the web app.** A modified bundle can
  capture the master password. Mitigations available: serve the web app from
  separate static hosting with its own deploy keys, publish bundle hashes, and
  prefer the extension/desktop apps for unlocking. Not solvable in code alone.
- **R3. 2FA is server-enforced, not cryptographic.** A server attacker with
  `SERVER_ENCRYPTION_KEY` can bypass TOTP, but this does not give vault access
  without the master password. The master password is the only cryptographic
  factor; passkey-PRF unlock is not built.
- **R4. Vault-key rotation: resolved.** Settings → Vault key generates a new
  key on the device, re-encrypts every field, field history, note body, note
  history and password fingerprint under it, then swaps the wrapped key. The
  server checks that every secret comes back encrypted, locks other sessions
  and refuses other writes meanwhile, and an interrupted rotation resumes at the
  next unlock (`apps/api/src/vault/rotation.ts`, `rotation.test.ts`,
  `tests/e2e/rotation.mjs`). Limits: data already copied off a compromised device
  stays readable with the old key, and backups exported earlier still open with
  the master password they were made with. The extension cannot run a rotation;
  it asks the user to finish it in the web app.
- **R5. Lockout trade-offs.** Anyone who knows an email can keep the account
  locked (up to 60 min per failure after the tenth). The 429 for a locked
  account also reveals that the email exists. This is standard, but noted.
- **R6. Team workspaces: implemented and tested, not independently reviewed.**
  Built by another session (ARCHITECTURE.md §7, SECURITY.md "Workspaces and
  sharing", `workspaces.test.ts`, `asym.test.ts`, `tests/e2e/workspaces.mjs`).
  No server-held key opens shared items; removal revokes server access at once
  and flags keys for rotation. Known limits: a malicious server could substitute
  a member's public key, and the defence is the fingerprint comparison in the
  confirm dialog, which only works if admins actually compare out of band (see
  also R11). Rotation protects future values only: a removed member may have
  copied what they saw. This design needs its own review before release.
- **R7. Notifications are in-app only.** New-device, lockout and 2FA changes are
  security events in the app; there is no email or push notification yet
  (there is no mail infrastructure).
- **R8. Rate limits are per process** unless `REDIS_URL` is set. Production
  with more than one instance must set it.
- **R9. Extension clipboard clearing is unconditional.** After 30 s the
  clipboard is emptied (from an offscreen document, also after the popup closes;
  tested in `tests/e2e/extension.mjs`) even if the user has copied something
  else since, because checking would need the `clipboardRead` permission.
- **R10. Dependency audit.** Open after this pass: `deepmerge-ts` (high, via
  the prisma CLI config loader; fix is a major version), and `file-type`,
  `esbuild`, `http-cache-semantics` (via `@nestjs/cli`/`@swc/cli` tooling). All
  are build-time or CLI-only, not in the API's runtime request path. The
  `http-cache-semantics` fix (4.3.0) was published today and is held back by
  the repo's minimum-release-age policy. `mysql2` (prisma CLI) is pinned to a
  fixed version via a pnpm override.
- **R11. Unverified email addresses: resolved.** Registration sends a single-use
  link (Resend API; token in the URL fragment, only its SHA-256 stored, 24 h,
  consumed atomically). Workspace invitations are invisible to, and cannot be
  accepted or confirmed for, an account whose address is unverified
  (`EMAIL_NOT_VERIFIED`); the operator dashboard is gated on account ids, not
  emails. Tested in `email-verification.test.ts`, `operator.test.ts` and
  `tests/e2e/verify-email.mjs`. The key-fingerprint comparison at confirm still
  protects against a malicious server substituting a public key (R6).

## Recovery and lifecycle

- **Forgotten master password:** the vault cannot be recovered, by design.
  Nobody, including the server operator, can reset it. 2FA recovery codes
  recover the *second factor* only, not the vault.
- **New device:** sign in with email, master password and 2FA; the client
  derives the keys locally. The server raises a `new_device` security event.
- **Lost device:** revoke it under Devices (ends its sessions immediately), or
  use Emergency lock. Its vault key may already have been in memory if it was
  unlocked when lost: change the vault key (R4) to protect anything written later,
  and change the passwords it could have read.
- **Master password change:** re-wraps the user key under the new password,
  replaces the auth hash and revokes every other session.
- **Key rotation:** master-password change re-wraps the user key; Settings →
  Vault key re-encrypts the whole personal vault under a new key (R4); workspace
  item and workspace keys are rotated by managers after a removal (R6).
- **Team member leaves / shared re-keying:** access ends immediately on the
  server; affected item keys and the workspace key are flagged and re-keyed from
  a manager's or admin's device; items only that person could open are deleted
  (R6). One-off share links carry their own random key in the URL fragment;
  revoking a link deletes its ciphertext.

## Security review gate (2026-10-04)

| # | Area | Status |
|---|---|---|
| 1 | Cryptographic architecture | Reviewed. Standard primitives (Argon2id, HKDF-SHA256, AES-256-GCM via WebCrypto, HMAC). No custom crypto. |
| 2 | Key management | Reviewed. Vault-key rotation added and tested (R4). |
| 3 | Authentication | Hardened: atomic lockout, cross-session 2FA limits, TOTP replay, atomic recovery-code and WebAuthn-challenge use. |
| 4 | Authorization | Reviewed every controller; IDOR tests extended. |
| 5 | Workspace isolation | Accounts: isolation tested. Team workspaces: implemented and tested by the workspaces work, not independently reviewed (R6). |
| 6 | Extension security | Hardened: permissions reduced, message validation, sender-derived hosts, offscreen clipboard clearing. |
| 7 | Autofill security | Hardened: PSL-aware matching, punycode, https-only, top frame, origin re-check. |
| 8 | Database security | Secrets encrypted; metadata plaintext by decision, with compensating controls (R1). |
| 9 | Backup security | Backups and exports contain only ciphertext for secrets. |
| 10 | Logging | Reviewed; tightened usage-field validation; settings changes audited. |
| 11 | Session security | Hardened: `__Host-` cookie in production; locked sessions get no wrapped keys. |
| 12 | Dependency security | Audited; one fix applied; remaining items are build-time (R10). |
| 13 | Threat model | This document. |
| 14 | Security tests | `hardening.test.ts`, `rotation.test.ts`, `workspaces.test.ts`, `operator.test.ts`, `url.test.ts`, `tests/e2e/*.mjs`, plus the existing suites. |

**Verdict:** suitable for continued development and private use. **Not
production-ready** until the production configuration check passes, HSTS and
frame-ancestors are set by the web host (see SECURITY.md), `REDIS_URL` is set
for multi-instance deployments, and the team-workspace design (R6) has had an
independent review.
