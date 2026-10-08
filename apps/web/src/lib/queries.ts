import type {
  ActivityEntry,
  DashboardSummary,
  NamedRef,
  NoteDetail,
  NoteSummary,
  Page,
  SecurityOverview,
  VaultItemSummary,
} from "@minions/core";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { del, get, patch, post } from "./api";
import { loadPersonalItem } from "./people-sharing";
import { useSession } from "./session";

export interface ItemFilters {
  q?: string;
  category?: string;
  types?: string;
  projectId?: string;
  collectionId?: string;
  tag?: string;
  favorite?: boolean;
  trash?: boolean;
  sort?: "updated" | "name" | "recent" | "frequent" | "created";
}

const unlocked = () => useSession.getState().status === "unlocked";

export function useItems(filters: ItemFilters) {
  const status = useSession((s) => s.status);
  return useInfiniteQuery({
    queryKey: ["items", filters],
    enabled: status === "unlocked",
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      get<Page<VaultItemSummary>>("/vault/items", {
        ...filters,
        favorite: filters.favorite ? "true" : undefined,
        trash: filters.trash ? "true" : undefined,
        cursor: pageParam,
        limit: 60,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useItem(id: string | undefined) {
  return useQuery({
    queryKey: ["item", id],
    enabled: !!id && unlocked(),
    // An item shared with people has its own key: open it before anything decrypts.
    queryFn: () => loadPersonalItem(id!),
    staleTime: 0,
  });
}

export interface ProjectRow extends NamedRef {
  description: string | null;
  archived: boolean;
  itemCount: number;
  noteCount: number;
}
export interface CollectionRow extends NamedRef {
  description: string | null;
  itemCount: number;
  noteCount: number;
}
export interface TagRow {
  id: string;
  name: string;
  itemCount: number;
  noteCount: number;
}

export function useProjects() {
  const status = useSession((s) => s.status);
  return useQuery({
    queryKey: ["projects"],
    enabled: status === "unlocked",
    queryFn: () => get<ProjectRow[]>("/projects"),
  });
}
export function useCollections() {
  const status = useSession((s) => s.status);
  return useQuery({
    queryKey: ["collections"],
    enabled: status === "unlocked",
    queryFn: () => get<CollectionRow[]>("/collections"),
  });
}
export function useTags() {
  const status = useSession((s) => s.status);
  return useQuery({
    queryKey: ["tags"],
    enabled: status === "unlocked",
    queryFn: () => get<TagRow[]>("/tags"),
  });
}

export function useDashboard() {
  const status = useSession((s) => s.status);
  return useQuery({
    queryKey: ["dashboard"],
    enabled: status === "unlocked",
    queryFn: () => get<DashboardSummary>("/dashboard"),
    staleTime: 5_000,
  });
}

export function useSecurity() {
  const status = useSession((s) => s.status);
  return useQuery({
    queryKey: ["security"],
    enabled: status === "unlocked",
    queryFn: () => get<SecurityOverview>("/security/findings"),
  });
}

export function useActivity(filter?: { itemId?: string; actions?: string }) {
  const status = useSession((s) => s.status);
  return useInfiniteQuery({
    queryKey: ["activity", filter],
    enabled: status === "unlocked" || status === "locked",
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      get<{ items: ActivityEntry[]; nextCursor: string | null }>("/activity", {
        cursor: pageParam,
        limit: 50,
        ...filter,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useNotes(filters: {
  view?: string;
  q?: string;
  projectId?: string;
  collectionId?: string;
  tag?: string;
}) {
  const status = useSession((s) => s.status);
  return useInfiniteQuery({
    queryKey: ["notes", filters],
    enabled: status === "unlocked",
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      get<Page<NoteSummary>>("/notes", { ...filters, cursor: pageParam, limit: 60 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useNote(id: string | undefined) {
  return useQuery({
    queryKey: ["note", id],
    enabled: !!id && unlocked(),
    queryFn: () => get<NoteDetail>(`/notes/${id}`),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Invalidates everything derived from vault items after a change. */
export function useInvalidateVault() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["items"] }),
      qc.invalidateQueries({ queryKey: ["item"] }),
      qc.invalidateQueries({ queryKey: ["dashboard"] }),
      qc.invalidateQueries({ queryKey: ["security"] }),
      qc.invalidateQueries({ queryKey: ["projects"] }),
      qc.invalidateQueries({ queryKey: ["project"] }),
      qc.invalidateQueries({ queryKey: ["collections"] }),
      qc.invalidateQueries({ queryKey: ["tags"] }),
      qc.invalidateQueries({ queryKey: ["ws"] }),
      qc.invalidateQueries({ queryKey: ["shared"] }),
      qc.invalidateQueries({ queryKey: ["people"] }),
    ]);
}

export function useToggleFavorite() {
  const invalidate = useInvalidateVault();
  return useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) =>
      patch(`/vault/items/${id}`, { favorite }),
    onSuccess: invalidate,
  });
}

export function useDeleteItem() {
  const invalidate = useInvalidateVault();
  return useMutation({
    mutationFn: (id: string) => del(`/vault/items/${id}`),
    onSuccess: invalidate,
  });
}

export function useRestoreItem() {
  const invalidate = useInvalidateVault();
  return useMutation({
    mutationFn: (id: string) => post(`/vault/items/${id}/restore`),
    onSuccess: invalidate,
  });
}

export interface BulkPatch {
  favorite?: boolean;
  projectId?: string | null;
  collectionId?: string | null;
  addTags?: string[];
}

/** Organises many items at once. Only plaintext metadata changes; nothing is re-encrypted. */
export function usePatchItems() {
  const invalidate = useInvalidateVault();
  return useMutation({
    mutationFn: (body: BulkPatch & { ids: string[] }) => patch("/vault/items/bulk", body),
    onSuccess: invalidate,
  });
}
