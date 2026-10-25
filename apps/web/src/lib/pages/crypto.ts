import {
  type CreatePageRequest,
  type DatabaseSchema,
  decryptBlob,
  decryptString,
  encryptBlob,
  encryptString,
  generateKey,
  type PageKind,
  type PageMeta,
  type PageNode,
  pageAad,
  unwrapKey,
  wipe,
  wrapKey,
} from "@minions/core";
import { ApiError, bearerHeaders } from "../api";
import { onVaultClosed, requireVaultKey, useSession } from "../session";

/**
 * Page cryptography (docs/NOTION_ALTERNATIVE_PLAN.md §2). Each page has its
 * own random key, wrapped by the vault key; title, icon, properties, content
 * and files are encrypted under it with AAD naming the page (and file).
 * Unwrapped page keys live in memory only and are wiped on lock.
 */

type Key = Uint8Array<ArrayBuffer>;

/** Editor documents carry a format version so later phases can migrate them. */
export interface PageContent {
  v: 1;
  /** ProseMirror JSON (pages) */
  doc?: unknown;
  /** Databases: their schema. */
  schema?: DatabaseSchema;
}

const keys = new Map<string, { wrapped: string; key: Key }>();

onVaultClosed(() => {
  for (const { key } of keys.values()) wipe(key);
  keys.clear();
});

function vaultId(): string {
  const id = useSession.getState().me?.vaultId;
  if (!id) throw new Error("Vault is locked");
  return id;
}

/** The key of a page, unwrapped once and remembered until the vault locks. */
export async function pageKeyOf(page: Pick<PageNode, "id" | "protectedKey">): Promise<Key> {
  const known = keys.get(page.id);
  if (known && known.wrapped === page.protectedKey) return known.key;
  const key = await unwrapKey(
    requireVaultKey(),
    page.protectedKey,
    pageAad.key(vaultId(), page.id),
  );
  if (known) wipe(known.key);
  keys.set(page.id, { wrapped: page.protectedKey, key });
  return key;
}

/** A page key this client just made, before the server has the page. */
export function rememberPageKey(pageId: string, wrapped: string, key: Key) {
  keys.set(pageId, { wrapped, key });
}

export async function decryptMeta(page: Pick<PageNode, "id" | "protectedKey" | "metaEnc">) {
  const key = await pageKeyOf(page);
  return JSON.parse(await decryptString(key, page.metaEnc, pageAad.meta(page.id))) as PageMeta;
}

export async function encryptMeta(pageId: string, key: Key, meta: PageMeta) {
  return encryptString(key, JSON.stringify(meta), pageAad.meta(pageId));
}

export async function decryptContent(
  page: Pick<PageNode, "id" | "protectedKey">,
  contentEnc: string | null,
): Promise<PageContent | null> {
  if (!contentEnc) return null;
  const key = await pageKeyOf(page);
  return JSON.parse(await decryptString(key, contentEnc, pageAad.content(page.id))) as PageContent;
}

export async function encryptContent(pageId: string, key: Key, content: PageContent) {
  return encryptString(key, JSON.stringify(content), pageAad.content(pageId));
}

/** Everything the API needs to create a page, encrypted here. */
export async function buildNewPage(opts: {
  id?: string;
  parentId: string | null;
  position: string;
  kind?: PageKind;
  meta: PageMeta;
  content?: PageContent | null;
  favorite?: boolean;
  /** Imports create their pages archived. */
  archived?: boolean;
}): Promise<{ request: CreatePageRequest; key: Key }> {
  const id = opts.id ?? crypto.randomUUID();
  const key = generateKey();
  const protectedKey = await wrapKey(requireVaultKey(), key, pageAad.key(vaultId(), id));
  rememberPageKey(id, protectedKey, key);
  return {
    key,
    request: {
      id,
      parentId: opts.parentId,
      position: opts.position,
      kind: opts.kind ?? "page",
      protectedKey,
      metaEnc: await encryptMeta(id, key, opts.meta),
      contentEnc: opts.content ? await encryptContent(id, key, opts.content) : null,
      ...(opts.favorite ? { favorite: true } : {}),
      ...(opts.archived ? { archived: true } : {}),
    },
  };
}

// ─── Files ───────────────────────────────────────────────────────────────────

export interface PageFileMeta {
  name: string;
  type: string;
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

/** Encrypts a file under the page key and uploads the ciphertext. Returns its id. */
export async function uploadPageFile(
  pageId: string,
  key: Key,
  bytes: Uint8Array<ArrayBuffer>,
  meta: PageFileMeta,
  fileId: string = crypto.randomUUID(),
): Promise<string> {
  const [blob, metaEnc] = await Promise.all([
    encryptBlob(key, bytes, pageAad.file(pageId, fileId)),
    encryptString(key, JSON.stringify(meta), pageAad.fileMeta(pageId, fileId)),
  ]);
  const res = await fetch(`${BASE}/pages/${pageId}/files/${fileId}`, {
    method: "PUT",
    headers: {
      ...bearerHeaders(),
      "content-type": "application/octet-stream",
      "x-minions-file-meta": metaEnc,
    },
    body: blob,
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
    throw new ApiError(res.status, data?.message ?? "Upload failed", data?.code);
  }
  return fileId;
}

const urls = new Map<string, Promise<{ url: string; meta: PageFileMeta }>>();

onVaultClosed(() => {
  for (const p of urls.values())
    void p.then(
      ({ url }) => URL.revokeObjectURL(url),
      () => {},
    );
  urls.clear();
});

/**
 * Downloads and decrypts a file into a blob: URL (allowed by the CSP, never
 * leaves the tab). Cached per file until the vault locks.
 */
export function pageFileUrl(
  page: Pick<PageNode, "id" | "protectedKey">,
  fileId: string,
): Promise<{ url: string; meta: PageFileMeta }> {
  const cacheKey = `${page.id}:${fileId}`;
  let p = urls.get(cacheKey);
  if (!p) {
    p = (async () => {
      const res = await fetch(`${BASE}/pages/${page.id}/files/${fileId}`, {
        headers: bearerHeaders(),
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) throw new ApiError(res.status, "File not found");
      const metaEnc = res.headers.get("x-minions-file-meta");
      const key = await pageKeyOf(page);
      const bytes = await decryptBlob(
        key,
        new Uint8Array(await res.arrayBuffer()),
        pageAad.file(page.id, fileId),
      );
      const meta: PageFileMeta = metaEnc
        ? JSON.parse(await decryptString(key, metaEnc, pageAad.fileMeta(page.id, fileId)))
        : { name: "file", type: "application/octet-stream" };
      return { url: URL.createObjectURL(new Blob([bytes], { type: meta.type })), meta };
    })();
    p.catch(() => urls.delete(cacheKey));
    urls.set(cacheKey, p);
  }
  return p;
}
