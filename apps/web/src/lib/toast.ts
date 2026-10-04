import { toastManager } from "@/components/ui/toast";

export const toast = {
  success: (title: string, description?: string) =>
    toastManager.add({ title, description, type: "success" }),
  error: (title: string, description?: string) =>
    toastManager.add({ title, description, type: "error" }),
  info: (title: string, description?: string) =>
    toastManager.add({ title, description, type: "info" }),
};
