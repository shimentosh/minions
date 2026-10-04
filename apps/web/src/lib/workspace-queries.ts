import type {
  ActivityEntry,
  ItemAccessResponse,
  MemberProfile,
  Page,
  WorkspaceDetail,
  WorkspaceInvitation,
  WorkspaceItemDetail,
  WorkspaceItemSummary,
  WorkspaceMember,
  WorkspaceSummary,
} from "@minions/core";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { get } from "./api";
import type { CollectionRow, ItemFilters, TagRow } from "./queries";
import { useSession } from "./session";
import { loadWorkspaceItem } from "./workspace-crypto";

/** Every workspace query key starts with "ws", so one invalidation refreshes them all. */

/**
 * Other people change shared data (access granted or revoked, items added), so
 * workspace lists refetch on mount and focus and poll gently. The server
 * enforces access either way; this only keeps the screen honest.
 */
const SHARED = { staleTime: 0, refetchOnWindowFocus: true, refetchInterval: 60_000 } as const;

function useUnlocked() {
  return useSession((s) => s.status) === "unlocked";
}

export function useWorkspaces() {
  const on = useUnlocked();
  return useQuery({
    queryKey: ["ws", "list"],
    enabled: on,
    queryFn: () => get<WorkspaceSummary[]>("/workspaces"),
  });
}

export function useInvitations() {
  const on = useUnlocked();
  return useQuery({
    queryKey: ["ws", "invitations"],
    enabled: on,
    queryFn: () => get<WorkspaceInvitation[]>("/workspaces/invitations"),
    refetchInterval: 60_000,
  });
}

export function useWorkspace(id: string) {
  const on = useUnlocked();
  return useQuery({
    queryKey: ["ws", id, "detail"],
    enabled: on,
    queryFn: () => get<WorkspaceDetail>(`/workspaces/${id}`),
    ...SHARED,
  });
}

export function useWorkspaceMembers(id: string, enabled = true) {
  const on = useUnlocked();
  return useQuery({
    queryKey: ["ws", id, "members"],
    enabled: on && enabled,
    queryFn: () => get<WorkspaceMember[]>(`/workspaces/${id}/members`),
  });
}

export function useWorkspaceItems(id: string, filters: ItemFilters, enabled = true) {
  const on = useUnlocked();
  return useInfiniteQuery({
    queryKey: ["ws", id, "items", filters],
    enabled: on && enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      get<Page<WorkspaceItemSummary>>(`/workspaces/${id}/items`, {
        ...filters,
        favorite: filters.favorite ? "true" : undefined,
        trash: filters.trash ? "true" : undefined,
        cursor: pageParam,
        limit: 60,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    ...SHARED,
  });
}

/** The item with its key opened, so its fields can be revealed. */
export function useWorkspaceItem(id: string, itemId: string | undefined) {
  const on = useUnlocked();
  return useQuery<WorkspaceItemDetail>({
    queryKey: ["ws", id, "item", itemId],
    enabled: on && !!itemId,
    staleTime: 0,
    queryFn: () => loadWorkspaceItem(id, itemId!),
  });
}

export function useWorkspaceFolders(id: string | undefined) {
  const on = useUnlocked();
  return useQuery({
    queryKey: ["ws", id, "folders"],
    enabled: on && !!id,
    queryFn: () => get<CollectionRow[]>(`/workspaces/${id}/folders`),
  });
}

export function useWorkspaceTags(id: string) {
  const on = useUnlocked();
  return useQuery({
    queryKey: ["ws", id, "tags"],
    enabled: on,
    queryFn: () => get<TagRow[]>(`/workspaces/${id}/tags`),
  });
}

export function useItemAccess(id: string, itemId: string, enabled = true) {
  const on = useUnlocked();
  return useQuery({
    queryKey: ["ws", id, "access", itemId],
    enabled: on && enabled,
    queryFn: () => get<ItemAccessResponse>(`/workspaces/${id}/items/${itemId}/access`),
  });
}

export function useMemberProfile(id: string, memberId: string) {
  const on = useUnlocked();
  return useQuery({
    queryKey: ["ws", id, "member", memberId],
    enabled: on,
    queryFn: () => get<MemberProfile>(`/workspaces/${id}/members/${memberId}`),
  });
}

type ActivityPage = { items: ActivityEntry[]; nextCursor: string | null };

export function useWorkspaceActivity(id: string, filter: { userId?: string } = {}) {
  const on = useUnlocked();
  return useInfiniteQuery({
    queryKey: ["ws", id, "activity", filter],
    enabled: on,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      get<ActivityPage>(`/workspaces/${id}/activity`, { cursor: pageParam, limit: 50, ...filter }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useWorkspaceItemActivity(id: string, itemId: string, enabled: boolean) {
  const on = useUnlocked();
  return useQuery({
    queryKey: ["ws", id, "item-activity", itemId],
    enabled: on && enabled,
    queryFn: () => get<ActivityPage>(`/workspaces/${id}/items/${itemId}/activity`),
  });
}

export function useInvalidateWorkspaces() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["ws"] });
}
