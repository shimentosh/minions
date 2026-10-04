import type { CaptureResult } from "@minions/core";
import { create } from "zustand";
import type { CustomFieldInput } from "./vault-crypto";

export interface EditorRequest {
  /** Edit an existing item. */
  itemId?: string;
  /** Create a new item of this type. Omitted = show the type picker first. */
  type?: string;
  /** Prefilled plaintext values (from Quick Capture, the generator, an import). */
  values?: Record<string, string>;
  custom?: CustomFieldInput[];
  name?: string;
  projectId?: string | null;
  collectionId?: string | null;
  tags?: string[];
  /** A Quick Capture result: fields are filled from it once a type is chosen. */
  capture?: CaptureResult;
  /** AI suggestion id to confirm or correct after saving. */
  classificationId?: string;
  /** Create or edit a credential in this workspace instead of the personal vault. */
  workspaceId?: string;
}

interface UiState {
  paletteOpen: boolean;
  captureOpen: boolean;
  editor: EditorRequest | null;
  setPalette: (open: boolean) => void;
  setCapture: (open: boolean) => void;
  openEditor: (req: EditorRequest) => void;
  closeEditor: () => void;
}

export const useUi = create<UiState>((set) => ({
  paletteOpen: false,
  captureOpen: false,
  editor: null,
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setCapture: (captureOpen) => set({ captureOpen }),
  openEditor: (editor) => set({ editor, paletteOpen: false, captureOpen: false }),
  closeEditor: () => set({ editor: null }),
}));
