import { toastManager } from "@/components/ui/toast";

export const toast = {
  success: (title: string, description?: string) =>
    toastManager.add({ title, description, type: "success" }),
  error: (title: string, description?: string) =>
    toastManager.add({ title, description, type: "error" }),
  info: (title: string, description?: string) =>
    toastManager.add({ title, description, type: "info" }),
};

/** A success toast with one action button, e.g. Undo after a move. */
export function toastWithAction(title: string, label: string, onAction: () => void) {
  const id = toastManager.add({
    title,
    type: "success",
    actionProps: {
      children: label,
      onClick: () => {
        toastManager.close(id);
        onAction();
      },
    },
  });
  return id;
}
