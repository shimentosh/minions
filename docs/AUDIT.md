# Repository audit (2026-10-23)

Scope: branch `feature/notion-alternative` at `5005259`, before any Notion-alternative
work. Purpose: know exactly what we build on, and what could break, before adding
encrypted pages, databases and a Notion importer. Back to the [README](../README.md).

## 1. Summary

Minions is a well-built, security-first monorepo. The crypto design is standard and
documented (Argon2id → HKDF → AES-256-GCM with AAD binding, RSA-OAEP for sharing), the
server enforces "ciphertext only" for secrets, and the API has a real integration suite
against PostgreSQL. It already ships rich-text **notes** (TipTap 3, encrypted HTML body)
and a **Notion CSV** credential import, which are the natural starting points.

What matters most for the Notion-alternative work:

| # | Finding | Impact on pages |
|---|---|---|
| A1 | Note **titles are plaintext** (`notes.title`, trigram-indexed). Only bodies are encrypted. | Pages must not copy this: titles go in ciphertext, search moves to the client. |
| A2 | Vault-key rotation re-encrypts every row that has `key_gen`, then swaps the key. Anything encrypted under the vault key but *not* enrolled in rotation becomes unreadable after a rotation. | Pages **must** join rotation (or use per-page keys wrapped by the vault key, so rotation only re-wraps). |
| A3 | Backup export/restore covers items, notes, projects, collections, tags, relations. | Pages must be added, or a backup silently misses them. |
| A4 | JSON body limit 3 MB (API) and 4 MB (nginx). No binary upload path exists. | Images/files from Notion need a separate encrypted upload route and a bigger nginx limit on it. |
| A5 | No CI workflows in `.github/`. Checks are run by hand. `pnpm lint` fails today (2 formatting errors in `tests/e2e/*.mjs`), `pnpm test` fails today (web has `vitest run` and no test files). `tests/e2e/backup.mjs` and `rotation.mjs` no longer match the Settings tabs and new-item dialog. | Fix both so "keep checks passing" is meaningful; recommend a CI workflow. (Lint, web tests and the two browser tests were fixed on this branch.) |
| A6 | One API test flaked (`vault.test.ts` SSH_KEY round-trip, "socket hang up") in a 162-test run. | Watch; rerun before blaming new code. |
| A7 | Web app is served from the same server that holds ciphertext (R2 in the threat model). | Unchanged by pages, but more valuable data (all of a person's documents) raises the stakes. Prefer desktop/extension for unlocking; publish bundle hashes. |

## 2. Architecture

```
apps/api        NestJS 11 + Prisma 7 + PostgreSQL 17, REST, cookie (web) or bearer (extension/desktop)
apps/web        Vite 8 + React 19 + TanStack Router/Query + Tailwind v4 + Base UI (coss-ui)
apps/extension  Chrome MV3, esbuild, no framework
apps/desktop    Tauri 2 shell around the web build
packages/core   Crypto, item-type registry, TOTP, generator, detection, classification, import parsers
tests/e2e       Playwright scripts (manual, need `pnpm dev`)
```

* **API modules**: one Nest module per area (`notes`, `imports`, `workspaces`,
  `people-sharing`, `shares`, `security`, `operator`, …). Services and controllers often
  share one file (`notes.module.ts`). DTOs use `class-validator` with
  `forbidNonWhitelisted`, so smuggled fields are rejected.
* **Guards**: global `SessionGuard` (cookie + `X-Minions-Client` header as CSRF defence,
  or bearer). `VaultUnlockedGuard` on everything that returns or accepts ciphertext;
  it also refuses writes while a vault-key rotation is pending.
* **Web**: in-memory keys (`lib/session.ts`, module scope, wiped on lock); TanStack
  Query cache cleared on lock; heavy screens lazy-loaded (`notes`, `import`, `settings`).
  CSP in the built `index.html`: `script-src 'self' 'wasm-unsafe-eval'`, `img-src 'self'
  data: blob:`, `connect-src 'self' <api>`; no inline scripts.
* **Core**: dependency-light by policy (CONTRIBUTING: "No new dependency in
  `packages/core` without a strong reason"). Only `hash-wasm` and `tldts`.

## 3. Data model (relevant parts)

`users → vaults (personal: user_id set; workspace: user_id null) → vault_items →
vault_item_fields / vault_item_versions`, plus `projects`, `collections`, `tags`,
`notes`, `note_versions`, `note_tags`, workspaces (`workspaces`,
`workspace_members`, `workspace_item_grants`), people sharing (`item_shares`), link
shares (`shares`), imports (`import_jobs`, `import_items`), security and activity logs.

* Ids that appear in AAD are **client-generated UUIDs** (items, notes), so the client
  can encrypt before the first save. Pages should follow this.
* Item types are registry strings in `@minions/core`, not DB enums: new vault item
  kinds need no migration.
* Every vault row has `key_gen`; rotation moves rows to `key_gen + 1`.
* Notes: `title` plaintext, `content_enc` envelope (AAD `note:<id>:content`), soft
  delete, archive, version every ≥10 min on save, revision-based optimistic locking
  (`REVISION_CONFLICT`). This is the pattern pages should reuse.
* 14 migrations, hand-named, applied by `prisma migrate deploy` at container start.

## 4. Crypto model

```
master password ─Argon2id(64 MiB,t=3)→ masterKey ─HKDF→ authKey (server stores Argon2id(authKey))
                                                 └HKDF→ stretchedKey → unwraps userKey → unwraps vaultKey
envelope = "v1.<iv b64>.<ciphertext+tag b64>", AES-256-GCM, AAD binds row + field
workspaces: workspace key sealed per member (RSA-OAEP-3072), per-item keys wrapped by it or sealed per member
people sharing: per-item key wrapped by vault key (keyAad.itemKeyForVault) and sealed per recipient
```

Strengths: standard primitives only, AAD everywhere, server-side envelope checks
(`PLAINTEXT_SECRET`), wrapped keys only to unlocked sessions, rotation with resume.

Deliberate exceptions to remember: **email reset** (on by default) lets
`SERVER_ENCRYPTION_KEY` + DB open the vault; **metadata is plaintext** (R1: item names,
usernames, hosts, tags, note titles). Encrypted pages make the second one stricter for
pages only; the first one applies to pages too (they hang off the same user key), and the
plan must say so.

## 5. Code quality

* Consistent style (Biome, 2-space, 100 cols), strict TypeScript, good comments that
  explain *why*. Security reasoning lives next to the code.
* Some large files: `item-editor.tsx` (1.2k lines), `settings-page.tsx` (1.1k),
  `auth.service.ts` (970). Not a blocker; new code should be split by concern.
* Services query Prisma directly with the vault id in every `where`; that is the IDOR
  defence and new modules must keep it.
* Web data access is centralised in `lib/api.ts` + `lib/queries.ts`; crypto helpers in
  `lib/vault-crypto.ts`. New page code should follow the same split.

## 6. Tests and CI

| Suite | Where | State today |
|---|---|---|
| Core unit | `packages/core/src/*.test.ts` (vitest) | 76/76 pass |
| API integration | `apps/api/test/*.test.ts` (vitest + supertest, real Postgres `minions_test`) | 160 pass, 1 flaky, 1 skipped |
| Web unit | `apps/web` has `vitest run`, jsdom, Testing Library | **no test files → `pnpm test` exits 1** |
| E2E | `tests/e2e/*.mjs` (Playwright, need running stack) | manual only |
| Lint | `biome check .` | **fails**: formatting in `tests/e2e/backup.mjs`, `features.mjs` |
| Typecheck | `pnpm -r typecheck` | passes |
| CI | `.github/` has templates, CODEOWNERS, security policy | **no workflows** |

The API suite has a strong pattern worth copying: "dump every table and assert no
plaintext secret appears" (`vault.test.ts`). Pages get the same test.

## 7. Deployment ("online build")

* `docker-compose.prod.yml` targets **Dokploy** behind Traefik: `web` (nginx serving the
  SPA and proxying `/api/*` → `minions-api:4600`) and `api` (runs `prisma migrate deploy`
  on start). PostgreSQL 17 and Redis are separate Dokploy services.
* The production web origin used by the extension build is `https://minion.sentosh.com`
  (`apps/extension/package.json`, `build:prod`).
* Migrations run automatically on deploy, so a new migration must be additive and safe
  on a live database (new tables only, no rewrites of existing rows).
* nginx `client_max_body_size 4m` and the API's 3 MB JSON limit cap request size.

## 8. Risks for the Notion-alternative features

1. **Rotation data loss** (A2). Highest risk. Mitigation: per-page content keys wrapped
   by the vault key; rotation re-wraps them; a test proves pages open after rotation.
2. **Plaintext leaking through metadata**. Titles, icons, property values, database
   schemas, file names and MIME types must all be ciphertext. What stays visible:
   tree shape (parent ids), sibling order, page/database kind, sizes, timestamps.
3. **Server-side search** cannot see titles or content. Search becomes a client-side,
   in-memory index built after unlock. Fine for thousands of pages; very large
   workspaces need incremental indexing (plan, phase 2).
4. **XSS through imported HTML**. Notion HTML is untrusted. Only ProseMirror's schema may
   reach the DOM; links restricted to http(s)/mailto and internal ids; DOMPurify before
   parsing; no `dangerouslySetInnerHTML`.
5. **Large imports**. Exports can be gigabytes, split into several zips, sometimes nested.
   The browser must stream from the `File` (random access), not load it whole, and the
   API must accept pages in batches.
6. **Secrets in pages**. People keep passwords in Notion pages. The importer should move
   them into vault items (with the Security Center, history and autofill) rather than
   leave them in page text, and say what it did.
7. **Bundle size / CSP**. A block editor and zip/markdown libraries add weight; keep them
   in lazy chunks. No library may need `eval`, remote fonts or remote scripts.
8. **Workspaces (team sharing of pages)**: the item-key model does not map 1:1 to page
   trees (inherited access). Needs its own design and review (R6 already flags the
   workspace design as unreviewed).
9. **Email reset** means the server operator can, with its key and the DB, open pages
   of accounts that keep email reset on. The plan and UI should say this plainly.

## 9. Recommendations before/while building

* Add `.github/workflows/ci.yml`: install, build core, typecheck, lint, core + web tests,
  API tests against a Postgres service container.
* Fix the two lint errors and give the web package real tests (done in phase 1).
* Keep `packages/core` dependency-free: put the Notion importer in the web app.
* Document every new thing the server can see in ARCHITECTURE.md §1 and THREAT_MODEL.md.
