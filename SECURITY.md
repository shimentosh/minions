# Security verification

What the spec's §66 asks for, and the evidence for each item. The design itself
is in [ARCHITECTURE.md](ARCHITECTURE.md) §1–2. Threat actors, residual risks and
the security review gate are in [THREAT_MODEL.md](THREAT_MODEL.md).

| Requirement | How it is enforced | Verified by |
|---|---|---|
| No plaintext secrets in PostgreSQL | Sensitive fields are encrypted on the client. The API rejects a registry-sensitive field that is not an envelope (`PLAINTEXT_SECRET`), whatever the client claims. | `vault.test.ts` "stores no plaintext secret anywhere": dumps every table after creating every credential type, a note and usage events. Also a manual scan of the dev database after the browser tests. |
| No secrets in logs | Activity metadata is whitelisted to ids, counts and labels. The error filter logs only error names and codes. Prisma query logging is off. | Activity checked in the DB dump above; API and web dev logs scanned for test secrets. |
| No secrets in URLs | Secrets travel only in JSON bodies. Query strings carry ids, hosts and search terms over safe metadata. | Code review of every controller; the extension's `match` takes a host only. |
| No secrets in error responses | `SafeExceptionFilter`; validation errors never echo values. | `vault.test.ts` checks the rejected plaintext is absent from the response. |
| No secrets committed to Git | `.env` ignored; only `.env.example` files, with empty keys. | `.gitignore` |
| No decrypted vault in browser storage | The vault key lives in module memory (web) or `chrome.storage.session` (extension: memory-only, trusted contexts only). Locking wipes it and clears the query cache. A reload locks. | `extension.mjs` checks `chrome.storage.local` holds only the device id; `smoke.mjs` relies on reload-locks behaviour. |
| No sensitive AI payloads | Financial types never reach the AI. Payloads go through `sanitizeForAi` on the client and server, then `DeepSeekClient.assertSafe` refuses to send anything secret-shaped. The AI sees only names, hosts, providers and redacted text. | `intelligence.test.ts`: card numbers, Stripe keys, AWS ids, passwords and long digit runs absent from the captured request; financial types make no call; user opt-out respected. |
| Authentication | Argon2id (client, 64 MiB) → HKDF auth key → Argon2id again on the server. Unknown emails get a stable fake salt. | `auth.test.ts` |
| Authorization | Every query is scoped by the session's vault id; ids from another vault return 404. | `vault.test.ts` "one user can never reach another's vault" |
| Rate limiting / brute force | Global throttle; 10/min on auth routes; one atomic per-account failure counter for passwords, unlock, TOTP and passkeys, with lockout and backoff, not reset by the password alone; 5 wrong 2FA codes also revoke the pending session; share passphrase guesses counted atomically. | `auth.test.ts`, `hardening.test.ts` "brute-force protection" (parallel guesses, 2FA across fresh sign-ins) |
| Second-factor replay | TOTP time step accepted once; recovery codes and passkey challenges consumed atomically. | `hardening.test.ts` "second factor replay" |
| Locked session | `/vault/kdf` returns only KDF parameters; wrapped keys need an unlock. | `hardening.test.ts` "a locked session exposes no key material" |
| IDOR / BOLA | Every id is looked up together with the session's vault/user; smuggled `userId`/`vaultId` in bodies are rejected by DTO whitelisting. | `vault.test.ts`, `hardening.test.ts` "IDOR / BOLA" (items, trash, merge, shares, sessions, devices, passkeys, activity, export, revoked device token) |
| Autofill / lookalike domains | Public Suffix List matching (`tldts`, private suffixes included), punycode comparison, https-only for https logins, top frame only, origin re-checked by the content script. | `packages/core/src/url.test.ts`, `hardening.test.ts` "site matching", `tests/e2e/extension.mjs` (wrong-site fill refused) |
| Password saving | Explicit Save / Never for this site / Cancel; host from the browser, not the page; synthetic clicks ignored; pending login expires in 5 min. | `tests/e2e/extension.mjs` |
| Extension permissions | `storage`, `activeTab`, `alarms`, `offscreen`, `clipboardWrite`; API origin only; no `tabs`, no `<all_urls>`. | `tests/e2e/extension.mjs` checks the shipped manifest |
| Production config | Refuses dev DB password, http origins, localhost RP id, reused server key. | `hardening.test.ts` "production configuration" |
| Email ownership | Single-use link sent through the Resend API at sign-up (token only in the URL fragment, SHA-256 stored, 24 h, atomic); workspace invitations hidden from, and refused for, unverified addresses. | `email-verification.test.ts` (single use, expiry, superseded links, race, squatter cannot see or accept an invitation), `tests/e2e/verify-email.mjs` |
| Vault-key rotation | New key generated and every secret re-encrypted on the device; the server checks each secret and history entry comes back as an envelope, locks other sessions, refuses other writes and exports until the swap, and resumes an interrupted rotation at the next unlock. | `rotation.test.ts` (old key opens nothing afterwards; plaintext, dropped secrets and other accounts' rows refused; resume), `tests/e2e/rotation.mjs` |
| Sessions | Random 256-bit tokens, only SHA-256 stored; HttpOnly SameSite=Strict cookie plus a required `X-Minions-Client` header (CSRF). | `auth.test.ts` "requires the client header" |
| Auto-lock | The client locks on idle. The server refuses vault routes once the unlock window passes; the window slides only with real use. | `vault.test.ts` "locks by itself"; smoke test lock/unlock |
| Device and session revocation, emergency lock | Revoking ends sessions immediately; emergency lock ends all of them, including the caller's. | `auth.test.ts` |

## Known limits

- The server sees safe metadata (names, hosts, usernames, providers, tags) and
  coarse signals: password strength score, whether TOTP exists, card last 4,
  and a keyed fingerprint that reveals only *equality* between the user's own
  passwords. This is what makes server-side search, reuse detection and the
  Security Center possible without decrypting anything.
- Note bodies are encrypted, so note search covers titles, tags and organisation only.
- The extension clears the clipboard 30 s after a copy from an offscreen
  document, also after the popup closes; it clears unconditionally, since
  checking the current contents would need `clipboardRead`. Tested in
  `tests/e2e/extension.mjs`.

## Deployment requirements

The web app's CSP ships in `index.html` (build only). These must be set by
the web server or CDN, because a `<meta>` tag cannot carry them:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Content-Security-Policy: frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
```

The API sets its own headers (Helmet: HSTS, `default-src 'none'`,
`frame-ancestors 'none'`, nosniff, no-referrer) and `Cache-Control: no-store`.
Also: run with `NODE_ENV=production` (enables the config check and Secure
`__Host-` cookie), set `RESEND_API_KEY`, `MAIL_FROM` (an address on a domain
verified in Resend) and `PUBLIC_WEB_URL` (https; links in emails point there), set `EXTENSION_ORIGINS` to the published extension id, set
`REDIS_URL` when running more than one API instance, keep
`SERVER_ENCRYPTION_KEY` and `PRELOGIN_SECRET` in a secret manager (never in
the image or the repository), and encrypt database backups at rest even though
vault secrets inside them are already ciphertext.

## Passkeys

WebAuthn credentials (`webauthn_credentials`: id, public key, counter,
transports) are a second factor. Adding or removing one requires the master
password, so a stolen session cannot enrol its own authenticator. Challenges
are per session, single use and expire after five minutes; signature counters
are checked and updated. Relying party and allowed origins come from
`WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS`. Verified end to end with a virtual
authenticator (`tests/e2e/features.mjs`).

A passkey does not open the vault: the vault key is derived from the master
password. Passkey-only unlock would need the PRF extension and is not built.

## Other additions

- **Backup restore** decrypts on the device and re-encrypts under the current
  vault key before anything is sent (`tests/e2e/backup.mjs` also checks the
  downloaded file holds no plaintext).
- **Paste anything** and the Authenticator's QR import run on the device; the
  pasted text is cleared from the box once fields are filled.
- **Field suggestions** come only from non-sensitive (plaintext) fields.
- **Desktop session token** is stored in the OS credential store (Windows
  Credential Manager / macOS Keychain / Secret Service) through three narrow
  Tauri commands; the vault key is never stored.

## Share links

- The share is encrypted in the sender's browser with a fresh 256-bit key that
  lives only in the link's `#fragment`. Browsers never send the fragment to a
  server, so Minions stores ciphertext it cannot read.
- An optional passphrase adds a second key (Argon2id, never sent). The server
  keeps only a hash of a token derived from it, refuses wrong guesses before
  handing out anything, and destroys the share after 10 wrong attempts.
- Views are counted atomically in the same statement that returns the
  ciphertext, so a one-time link opens exactly once even under concurrent
  requests. The last view, expiry or a revoke deletes the ciphertext; a job
  also wipes expired ones every 10 minutes.
- Nothing is fetched until the recipient presses "Reveal", so chat-app link
  previews don't consume a one-time link. The recipient page removes the key
  from the address bar after reading it.
- Sharing 2FA shares the TOTP secret itself; the dialog says so.
- Every creation, view (with the viewer's IP) and revoke is in the owner's
  activity log. Tested in `apps/api/test/shares.test.ts` and `tests/e2e/share.mjs`.

## Workspaces and sharing

| Requirement | How it is enforced | Verified by |
|---|---|---|
| No server-held key for shared items | Item keys are sealed to members' RSA-OAEP public keys or wrapped by a workspace key that is itself sealed per member. The server stores only those envelopes. | `workspaces.test.ts` "stores no plaintext secret anywhere"; `asym.test.ts` |
| Server-side authorisation on every route | `WorkspaceAccess` resolves membership from the session, never from the body; a workspace the caller is not in answers 404; view-only callers get 403 on edit, delete, share, history. | `workspaces.test.ts` "credential access", "membership" |
| Workspace and vault isolation | Workspace item ids through another workspace, or through `/vault/items`, `/relations`, answer 404. | `workspaces.test.ts` "isolation" |
| Unconfirmed members see nothing | ACCEPTED members get `MEMBERSHIP_PENDING` and no workspace key. | `workspaces.test.ts` |
| Revocation | Grants and memberships are deleted in one transaction; affected items and the workspace key are flagged and can be rotated. | `workspaces.test.ts` "removing a member", "re-keys an item" |
| Keys bound to context | OAEP label / AAD name item, workspace and recipient. | `asym.test.ts` "binds the sealed key" |
| Safe site matching for team logins | Same PSL-aware matcher; look-alike and sibling-suffix hosts get nothing. | `workspaces.test.ts` "matches sites safely" |
| Audit without secrets | Metadata whitelist; values never logged. | `workspaces.test.ts` "audit log" |

Known limits: the server could hand out a substituted public key; the confirm dialog's
fingerprint comparison is the mitigation and depends on people doing it. Someone who
lost access may have copied what they saw: rotation protects future values, not past ones,
so change the password at the service too. Invitations are not emailed (there is no mail
service); the invitee sees them after signing in with that address.

## Operator dashboard

Allowlist of account ids (`OPERATOR_USER_IDS`, not emails: email ownership is not verified) checked on every request, unlocked vault, two-factor outside
development, 404 for everyone else, every view audit-logged, no vault content in any
response. Verified by `operator.test.ts`.
