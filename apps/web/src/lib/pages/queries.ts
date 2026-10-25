import type { PageDetail, PageKind, PageMeta, PageNode, PageVersion } from "@minions/core";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { setPagesIndex } from "@/components/pages/pages-context";
import { del, errorMessage, get, patch, post, put } from "../api";
import { useShowArchived } from "../archive";
import { onVaultClosed, useSession } from "../session";
import { toast } from "../toast";
import {
  buildNewPage,
  decryptContent,
  decryptMeta,
  encryptContent,
  encryptMeta,
  type PageContent,
  pageKeyOf,
} from "./crypto";
import { archivedSet, indexPages, type PageEntry, type PageIndex, positionAtEnd } from "./tree";

/**
 * Pages as the UI sees them. The tree is one request after unlock; every
 * title is decrypted here, on the device, so search and the sidebar never
 * need the server to read anything.
 */

/** Decrypted meta by page, reused while its ciphertext is unchanged. Memory only. */
const metas = new Map<string, { metaEnc: string; meta: PageMeta | null }>();
onVaultClosed(() => metas.clear());

async function decryptNodes(nodes: PageNode[]): Promise<PageEntry[]> {
  const out: PageEntry[] = [];
  // Small chunks keep the tab responsive while thousands of titles decrypt.
  for (let i = 0; i < nodes.length; i += 200) {
    const chunk = await Promise.all(
      nodes.slice(i, i + 200).map(async (n) => {
        let meta = metas.get(n.id)?.metaEnc === n.metaEnc ? metas.get(n.id)!.meta : undefined;
        if (meta === undefined) {
          meta = await decryptMeta(n).catch(() => null);
          metas.set(n.id, { metaEnc: n.metaEnc, meta });
        }
        if (!meta) return { ...n, title: "🔒 Can't decrypt" };
        return { ...n, title: meta.title ?? "", icon: meta.icon, props: meta.props };
      }),
    );
    out.push(...chunk);
  }
  return out;
}

export const PAGES_KEY = ["pages"] as const;

export function usePageTree(view: "active" | "trash" = "active") {
  const status = useSession((s) => s.status);
  const query = useQuery({
    queryKey: [...PAGES_KEY, "tree", view],
    enabled: status === "unlocked",
    staleTime: 60_000,
    queryFn: async () => decryptNodes((await get<{ pages: PageNode[] }>("/pages", { view })).pages),
  });
  const index = useMemo<PageIndex>(() => indexPages(query.data ?? []), [query.data]);
  useEffect(() => {
    if (view === "active") setPagesIndex(query.data ? index : null);
  }, [view, index, query.data]);
  // Archived pages (and pages under them) are left out unless the person shows them.
  const show = useShowArchived((s) => s.show);
  const archived = useMemo(() => archivedSet(index), [index]);
  const visible = useMemo(
    () => (show || !archived.size ? query.data : query.data?.filter((p) => !archived.has(p.id))),
    [show, archived, query.data],
  );
  const visibleIndex = useMemo(
    () => (visible === query.data ? index : indexPages(visible ?? [])),
    [visible, query.data, index],
  );
  return { ...query, pages: query.data, index, archived, visible, visibleIndex };
}

export interface OpenPage {
  detail: PageDetail;
  meta: PageMeta;
  content: PageContent | null;
}

export function usePage(id: string | undefined) {
  const status = useSession((s) => s.status);
  return useQuery({
    queryKey: [...PAGES_KEY, "page", id],
    enabled: !!id && status === "unlocked",
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<OpenPage> => {
      const detail = await get<PageDetail>(`/pages/${id}`);
      const [meta, content] = await Promise.all([
        decryptMeta(detail),
        decryptContent(detail, detail.contentEnc),
      ]);
      return { detail, meta, content };
    },
  });
}

export function usePageVersions(page: PageDetail | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...PAGES_KEY, "versions", page?.id],
    enabled: !!page && enabled,
    queryFn: async () => {
      const rows = await get<PageVersion[]>(`/pages/${page!.id}/versions`);
      return Promise.all(
        rows.map(async (v) => ({
          ...v,
          meta: await decryptMeta({ ...page!, metaEnc: v.metaEnc }),
        })),
      );
    },
  });
}

/** Saves title/icon/props and content. Returns the stored page. */
export async function savePage(
  page: PageDetail,
  meta: PageMeta,
  content: PageContent | null,
): Promise<PageDetail> {
  const key = await pageKeyOf(page);
  return put<PageDetail>(`/pages/${page.id}`, {
    metaEnc: await encryptMeta(page.id, key, meta),
    contentEnc: content ? await encryptContent(page.id, key, content) : null,
    revision: page.revision,
  });
}

/** Stable for the life of the query client, so it is safe in effect dependencies. */
export function usePageActions() {
  const qc = useQueryClient();
  return useMemo(() => pageActions(qc), [qc]);
}

function pageActions(qc: QueryClient) {
  const refresh = () => qc.invalidateQueries({ queryKey: [...PAGES_KEY, "tree"] });
  const index = (): PageIndex =>
    indexPages(qc.getQueryData<PageEntry[]>([...PAGES_KEY, "tree", "active"]) ?? []);

  return {
    refresh,
    async create(opts: {
      parentId: string | null;
      title?: string;
      kind?: PageKind;
      content?: PageContent | null;
      icon?: string;
    }) {
      const { request } = await buildNewPage({
        parentId: opts.parentId,
        position: positionAtEnd(index(), opts.parentId),
        kind: opts.kind,
        meta: { title: opts.title ?? "", ...(opts.icon ? { icon: opts.icon } : {}) },
        content: opts.content ?? null,
      });
      await post<PageDetail>("/pages", request);
      await refresh();
      return request.id;
    },
    async move(id: string, to: { parentId?: string | null; position?: string }) {
      await patch(`/pages/${id}`, to);
      await refresh();
    },
    /** Shows the change at once (star, sidebar), then saves it; undone if saving fails. */
    async favorite(id: string, favorite: boolean) {
      const key = [...PAGES_KEY, "tree", "active"];
      const set = (on: boolean) =>
        qc.setQueryData<PageEntry[]>(key, (old) =>
          old?.map((p) => (p.id === id ? { ...p, favorite: on } : p)),
        );
      // A tree request already in flight would bring the old flag back.
      await qc.cancelQueries({ queryKey: key });
      set(favorite);
      try {
        await patch(`/pages/${id}`, { favorite });
        void refresh();
        toast.success(
          favorite ? "Added to favorites" : "Removed from favorites",
          favorite ? "It's at the top of the sidebar." : undefined,
        );
      } catch (e) {
        set(!favorite);
        toast.error("Couldn't change favorites", errorMessage(e));
      }
    },
    /** Archives pages with what is under them, or brings them back (with the pages above). */
    async archive(ids: string[], archived: boolean) {
      for (let i = 0; i < ids.length; i += 500)
        await post("/pages/archive", { ids: ids.slice(i, i + 500), archived });
      await refresh();
    },
    async trash(id: string) {
      await del(`/pages/${id}`);
      await qc.invalidateQueries({ queryKey: PAGES_KEY });
    },
    async restore(id: string) {
      await post(`/pages/${id}/restore`);
      await qc.invalidateQueries({ queryKey: PAGES_KEY });
    },
    async purge(id: string) {
      await del(`/pages/${id}/purge`);
      await qc.invalidateQueries({ queryKey: [...PAGES_KEY, "tree", "trash"] });
    },
  };
}
