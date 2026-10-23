# Minions as a Notion alternative: plan

Minions stays a password manager and gains Notion-style pages: a nested page tree, a
block editor, databases, links, search, templates, team sharing, trash and history, and a
one-step import of a whole Notion workspace. The rule that does not bend: **titles,
content, properties, files and imported data are encrypted on the device; the server
never sees plaintext.** Read [AUDIT.md](AUDIT.md) first for what this builds on.

## 1. Features

| Area | What the person gets | Phase |
|---|---|---|
| Page tree | Pages inside pages, any depth; sidebar tree with expand/collapse, drag to reorder and re-parent, "add sub-page", breadcrumbs | 1 |
| Block editor | Text, H1–H3, bulleted/numbered lists, to-dos, toggles, quotes, callouts, code blocks, dividers, tables, images, file attachments; slash menu (`/`), markdown shortcuts, block drag handle | 1 (drag handle 2) |
| Links | Links to other pages (survive renames, shown with the page's current title), links to vault items (credentials stay in the vault, the page shows a chip) | 1 |
| Search | Instant title search in the sidebar and ⌘K; full-text search across page content | titles 1, content 2 |
| Databases | A page that is a table of pages: typed properties (text, number, select, multi-select, date, checkbox, URL, email, phone, person, relation), table view | basic table 1 (from import), editing + views 2 |
| Views | Table, board, list, gallery, calendar; filters, sorts, grouping, saved per database | 2 |
| Templates | Page templates and database row templates; a starter gallery | 2 |
| History | Versions kept automatically (≥10 min apart), browse and restore | kept 1, UI 2 |
| Trash | Delete a page and its sub-pages together, restore them together, empty trash | 1 |
| Favorites, icons, covers | Emoji icons, favorites section, cover images | icons/favorites 1, covers 2 |
| Notion import | Upload the official export zip (Markdown & CSV, or HTML), preview, organise, import; credentials become vault items | 1 |
| Team workspaces | Pages in a team workspace, per-page access that inherits down the tree | 3 |
| Share a page | With a person (sealed key) or by link (key in the URL fragment), like items today | 3 |
| Comments, mentions of people | | 3 |
| Real-time co-editing | Encrypted CRDT updates (Yjs), presence | 4 |
| Export | Markdown/HTML zip of a page tree, decrypted on the device | 2 |

## 2. How pages fit the encrypted vault

### Keys

Each page gets its **own random 256-bit page key**, wrapped by the key of the vault it
lives in:

```
pageKey            random 256-bit, client only
pages.protected_key  AES-GCM(vaultKey, pageKey, AAD "vault:<vaultId>:page:<pageId>:key")
pages.meta_enc       AES-GCM(pageKey, JSON{title, icon, props…}, AAD "page:<pageId>:meta")
pages.content_enc    AES-GCM(pageKey, JSON{v, doc}, AAD "page:<pageId>:content")
page_versions.*      the previous meta/content envelopes, same AAD (restoring = copying back)
page_files.data      0x01 ‖ iv ‖ AES-GCM(pageKey, bytes, AAD "page:<pageId>:file:<fileId>")
page_files.meta_enc  AES-GCM(pageKey, JSON{name, type}, AAD "page:<pageId>:file:<fileId>:meta")
```

Why a key per page rather than the vault key directly:

* **Rotation is cheap and safe.** A vault-key rotation re-wraps one 60-byte key per page;
  page bodies, versions and multi-megabyte files are not re-encrypted. (AUDIT A2.)
* **Sharing works later without re-encryption.** Moving a page into a team workspace or
  sharing it with a person re-wraps or seals the page key, exactly like the per-item keys
  of ARCHITECTURE.md §7–8.
* AAD binds every ciphertext to its page (and file), so the server cannot swap bodies,
  titles or files between pages.

Ids are client-generated UUIDs (as for items and notes), so AAD can be computed before
the first save. The server checks every `*_enc` and `protected_key` is a well-formed
envelope (`PLAINTEXT_SECRET` otherwise), the same defence items have.

### What the server can and cannot see

| Visible (metadata) | Ciphertext only |
|---|---|
| Page ids, vault, parent id (the tree's shape), sibling order key, kind (`page` / `database`), favorite flag, created/updated/deleted times, revision, ciphertext sizes, number of files and their byte sizes | Titles, icons, covers, all content, database schemas and property values, view definitions, file names, file types, file contents, link targets inside content |

This is **stricter than notes** (whose titles are plaintext, AUDIT A1). The cost is that
the server cannot search; see Search.

Honest limits, to state in THREAT_MODEL.md: tree shape and sizes leak something (e.g.
"a database with 400 rows"); an active server compromise can still serve a malicious web
app (R2); accounts with **email reset on** can be opened by whoever holds
`SERVER_ENCRYPTION_KEY` and the database, and that now includes their pages.

### Content format

The decrypted content is ProseMirror JSON from the editor (`{ v: 1, doc }`), not HTML.
JSON is easier to transform on import, version (`v`), walk for links and search, and it
never goes through an HTML parser when it is opened. Rendering goes only through the
editor schema, so stored markup outside it cannot reach the DOM.

### Databases

A database is a page of kind `database`. Its encrypted content holds the schema
(`properties: [{id, name, type, options}]`) and views. Its rows are ordinary child pages;
each row's encrypted meta holds `props: {propertyId: value}`, and a row page can have
its own content and sub-pages, as in Notion. One storage model, one key model, one
importer target.

### Search

After unlock the client already has every page's meta (one request: the tree). Title
search is an in-memory filter over decrypted titles, instant for tens of thousands of
pages. Phase 2 adds full-text search with **MiniSearch** (MIT): an in-memory index built
in the background from decrypted content, never persisted unencrypted. For very large
vaults, phase 2 may persist the index *encrypted* under a key derived from the vault key.

### Rotation, backup, trash, history

* Rotation: a third batch kind `pages` re-wraps `protected_key` (server checks envelopes,
  bumps `key_gen`). `finish` refuses while any page is left.
* Backup: the encrypted export includes pages (wrapped keys + envelopes); restore unwraps
  with the backup's vault key and re-wraps with the current one. Files are listed with
  their ciphertext in phase 2 (they can be large).
* Trash: deleting a page stamps it and every descendant with the same `deleted_at`;
  restoring brings back exactly that group; purge deletes the subtree.
* History: on save, the previous meta/content becomes a version at most every 10 minutes
  (the notes rule), capped per page.

### Credentials inside pages

Passwords don't belong in page text. The editor has an inline **vault item chip**
(`vaultItem` node, attrs `{itemId}`) that shows the item's name and opens it; the
importer replaces credentials it finds in pages with such a chip and creates real vault
items (logins, API keys, secure notes) with the existing encryption, Security Center
checks, history and autofill.

## 3. Libraries (all compatible with AGPL-3.0)

| Need | Choice | License | Why / alternatives |
|---|---|---|---|
| Block editor | **Tiptap 3** core + StarterKit, `extension-details` (toggles), `extension-table`, `extension-list` (to-dos), `extension-image`, `extension-drag-handle-react`, `suggestion` (slash menu) | MIT | Already in the app (notes) with its sanitising reviewed in the threat model; Tiptap 3 open-sourced Details, DragHandle, UniqueID and FileHandler. Same engine as Docmost. We own the schema, which the importer and encryption need. |
| (considered) | BlockNote 0.56 | MPL-2.0 core, GPL-3.0 `xl-*` packages | Most Notion-like out of the box, but its UI is built on Mantine or shadcn/Radix (the app uses Base UI), it adds a second ProseMirror stack next to notes, and it hides the schema behind its own block model. Good fallback if editor UX work outgrows us. |
| (studied) | Docmost (AGPL-3.0), AFFiNE/BlockSuite (MPL-2.0 / MIT), AppFlowy (AGPL-3.0), Outline (BSL 1.1, **not** reusable code) | | Design reference: Docmost for Tiptap page trees and Notion import; AFFiNE for databases-as-blocks; AppFlowy for database views; Outline for import UX and document links. No code copied. |
| Zip reading | **@zip.js/zip.js** 2.x | BSD-3-Clause | Random access over a `File`/`Blob` (no need to load a multi-GB export into memory), Zip64, native `DecompressionStream`, works without web workers (CSP). fflate (MIT) needs the whole buffer in memory. |
| Markdown → HTML | **marked** | MIT | Mature GFM (tables, task lists); output goes through DOMPurify and then the editor schema. |
| HTML sanitising | DOMPurify (already a dependency) | Apache-2.0 / MPL-2.0 | |
| Sibling ordering | **fractional-indexing** | CC0-1.0 | Order keys that allow inserts between siblings without renumbering. |
| Full-text search (phase 2) | MiniSearch | MIT | Small, in-memory, no server. |
| Co-editing (phase 4) | Yjs + y-prosemirror | MIT | With encrypted update envelopes (the secsync pattern). |

Choices are recorded here and in each package.json; `packages/core` stays
dependency-free (CONTRIBUTING), so the importer lives in `apps/web/src/lib/notion/`.

## 4. Notion importer design

### Input

The official export (Settings → Export all workspace content, or "Export" on a page):

* **Markdown & CSV**: `Page Title <32-hex id>.md`, sub-pages in a folder `Page Title <id>/`;
  a database is `DB Name <id>.csv` (newer exports also `… _all.csv`) plus a folder with
  one `.md` per row; attachments sit next to the page that uses them, linked by relative,
  URL-encoded paths.
* **HTML**: the same tree with `.html` files; databases are `<table class="collection-content">`.
* Big workspaces come as several parts (`Export-…-Part-1.zip`, …) and sometimes as a zip
  of zips. The importer accepts several files at once and opens nested zips.

### Pipeline (all on the device)

```
1 Read      zip.js over the File (random access); nested zips opened in place; only text
            entries (.md/.html/.csv) are read up front, attachments stay in the zip until written
2 Index     each entry → node {notionId, title, path, parent, kind: page|database|row|file}
            ids from the "<title> <32hex>" names; parents from folder structure
3 Parse     Markdown → HTML (marked) / HTML page-body → DOMPurify → editor schema → JSON
            properties block under the title (md) / property table (html) → row props
            CSV → database schema (columns, inferred types) + rows matched to row pages
4 Link      relative links to other exported pages → page links by new id;
            images/files → encrypted attachments; unknown links → plain text links
5 Detect    credentials: database columns (password/username/api key/token…) via the
            existing Notion CSV mapper; page text via findSecrets + "label: value" pairs
            (Email:/Password:/API key:) grouped per block
6 Preview   tree with counts; per page include/skip; target (root or under a page);
            per credential: "make a vault item" (default) / "keep as text"; item type,
            project/collection; duplicates against the existing vault flagged
7 Write     new UUIDs and page keys; encrypt; create pages parents-first in batches
            (≤100 pages / ≤2 MB per request); upload files one by one (encrypted, size cap);
            create vault items through /imports in batches; replace secrets in content
            with vault-item chips; an import job records counts only
```

Nothing is sent before the person presses **Import**. The source file never leaves the
device. Progress is shown per stage; a failed batch can be retried, and pages already
created keep their ids, so a retry skips them.

### Credential rules

* A database whose columns look like credentials (password, username/email, url, api
  key, token, secret, 2FA) → its rows become vault items (the existing
  `parseGenericRows` mapping), the database page is still imported without those
  secret columns, and each row page gets a chip to its item.
* In page text: a line or table row with a password/secret label next to an
  email/username/url → one LOGIN; a provider-shaped key (`sk_live_…`, `ghp_…`, AWS ids…)
  → API_KEY; a PEM private key → SSH_KEY; anything else secret-shaped the person chooses
  → SECURE_NOTE. The secret is removed from the page text and a chip takes its place.
* Every decision is visible and changeable in the preview; nothing is silently dropped.

### Scale

Target: 10,000 pages and 1 GB of attachments in one import. Text entries are small and
parsed incrementally with yields to the UI; attachments are read out of the zip one at a
time when they are written; requests are batched and retried through rate limits. Files
above the per-file cap (25 MB in phase 1) are listed in the report and skipped, never
truncated.

Measured (`tests/bench/notion-import.mjs`, laptop, local dev stack): 10,000 pages, 300
database rows and 1,000 small images preview in ~9 s and import in ~12 s; the tab's JS
heap peaked near 490 MB, because every page's text is held until the import ends.
Releasing text as pages are written is a phase 2 item; real networks and large images
will be slower than this.

## 5. Roadmap

| Phase | Contents | Priority |
|---|---|---|
| **1 Encrypted pages foundation + import** (built on this branch; see below) | `pages`, `page_versions`, `page_files` tables and migration; `/pages` API (tree, get, batch create, update with revision check, move with cycle check, trash/restore/purge, versions, files); rotation and backup include pages; web: Pages section in the sidebar with the nested tree, page view with the block editor (all core blocks, slash menu, page links, item chips, encrypted images/files), title search; Notion importer (Markdown & CSV and HTML, nested zips, hierarchy, databases as table pages, credential extraction, preview/organise, batched encrypted write); tests; docs | **P0** (this branch) |
| 2 Databases & knowledge | Property editing, table/board/list/gallery/calendar views, filters/sorts/groups, relations; full-text search (MiniSearch); backlinks and `@` page mentions; templates; history UI with restore; block drag handle; covers; Markdown/HTML export; files in backups; CI workflow | P1 |
| 3 Teams & sharing | Pages in workspaces (page key wrapped by the workspace key), per-page grants inherited down the tree, re-keying on member removal, share a page with a person or by link, comments, activity on pages; independent review of the design (R6) | P1 |
| 4 Collaboration & reach | Real-time co-editing with encrypted Yjs updates, offline cache (encrypted), desktop and mobile polish, page import from Markdown folders, Confluence and Evernote | P2 |

### Phase 1 as built

Done: the three tables and migration; `/pages` (tree, get, batch create, revision-checked
save with versions, move with cycle check, trash/restore/purge, encrypted files); page
keys in vault-key rotation and in encrypted backups (export and restore); the sidebar
tree (favorites, expand, add inside, drag to reorder or nest, trash); the page view
(icon, title, block editor with slash menu, all core blocks, encrypted images and files
by upload or paste, sub-pages, page links, vault-item chips, autosave); database pages
as a read-only table of their rows; `/pages` with title search and the trash; and the
Notion importer as designed above, with the preview step. Tests: API integration
(`pages.test.ts`), core (`blob.test.ts`), web unit tests for the tree and every importer
stage, and browser tests (`tests/e2e/pages.mjs`, plus pages in `backup.mjs` and
`rotation.mjs`).

Left for phase 2 (as planned there): editing database properties and views, version
history UI, content search, block drag handle, covers, files in backups, and lowering
the importer's memory use on very large exports.

Not planned: a server-side Notion API importer. The Notion API cannot be called from the
browser (CORS), so a server proxy would see plaintext; a desktop-app-only connector can
be considered later.

## 6. Open questions for the owner

1. Should pages also live in team workspaces from day one of phase 3, or is personal
   first enough for your migration?
2. Per-file size cap for attachments (phase 1 default 25 MB) and total storage per
   account on the online build: PostgreSQL `bytea` is fine to a few GB; beyond that we
   should add S3-compatible object storage (ciphertext only).
3. Email reset is on by default and covers pages too. Keep that default for the online
   build, or turn it off for accounts that import a whole workspace?
4. The existing Notes section: keep it, or migrate notes into pages in phase 2?
