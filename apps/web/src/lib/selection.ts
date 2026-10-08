import { create } from "zustand";

/**
 * Items ticked in the current list, for bulk actions and multi-item drags.
 * Cleared when the list changes (another tab, filter or search).
 */
interface SelectionState {
  ids: Set<string>;
  /** Last item toggled, the anchor for shift-click ranges. */
  anchor: string | null;
  toggle: (id: string) => void;
  /** Selects every id between the anchor and `id` in `order`. */
  extend: (id: string, order: string[]) => void;
  set: (ids: string[]) => void;
  clear: () => void;
}

export const useSelection = create<SelectionState>((set, get) => ({
  ids: new Set(),
  anchor: null,
  toggle: (id) => {
    const ids = new Set(get().ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    set({ ids, anchor: id });
  },
  extend: (id, order) => {
    const { anchor } = get();
    const from = anchor ? order.indexOf(anchor) : -1;
    const to = order.indexOf(id);
    if (from < 0 || to < 0) return get().toggle(id);
    const ids = new Set(get().ids);
    for (const x of order.slice(Math.min(from, to), Math.max(from, to) + 1)) ids.add(x);
    set({ ids, anchor: id });
  },
  set: (ids) => set({ ids: new Set(ids), anchor: ids.at(-1) ?? null }),
  clear: () => set({ ids: new Set(), anchor: null }),
}));
