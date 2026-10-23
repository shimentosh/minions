import { create } from "zustand";

/**
 * Whether archived pages and vault items are shown. One switch for the whole
 * app (page tree, page search, vault lists, ⌘K), remembered on this device.
 * Only a yes/no is stored: nothing about the pages or items themselves.
 */

const KEY = "minions-show-archived";

const read = () => {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
};

export const useShowArchived = create<{
  show: boolean;
  setShow: (show: boolean) => void;
}>((set) => ({
  show: read(),
  setShow: (show) => {
    set({ show });
    try {
      localStorage.setItem(KEY, String(show));
    } catch {
      // Private mode: the choice lasts for this visit only.
    }
  },
}));
