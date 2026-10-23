import { create } from "zustand";
import type { PageIndex } from "@/lib/pages/tree";
import { onVaultClosed } from "@/lib/session";

/**
 * The decrypted page index, for places outside the normal React tree
 * (editor node views render through portals). Written by usePageTree's
 * consumers; cleared with the query cache when the vault locks.
 */
const usePagesStore = create<{ index: PageIndex | null }>(() => ({ index: null }));

export const usePagesIndex = () => usePagesStore((s) => s.index);
export const setPagesIndex = (index: PageIndex | null) => usePagesStore.setState({ index });

onVaultClosed(() => setPagesIndex(null));
