import { getItemType } from "@minions/core";
import {
  AtSign,
  BadgeCheck,
  Cloud,
  CreditCard,
  Database,
  FileCode,
  FileText,
  Globe,
  KeyRound,
  Landmark,
  LifeBuoy,
  LockKeyhole,
  type LucideIcon,
  NotebookPen,
  Server,
  Terminal,
  Timer,
  Wallet,
  Webhook,
} from "lucide-react";
import { cn } from "./cn";

const ICONS: Record<string, LucideIcon> = {
  globe: Globe,
  "key-round": KeyRound,
  "lock-keyhole": LockKeyhole,
  "file-code": FileCode,
  webhook: Webhook,
  timer: Timer,
  "life-buoy": LifeBuoy,
  server: Server,
  terminal: Terminal,
  database: Database,
  cloud: Cloud,
  "at-sign": AtSign,
  "credit-card": CreditCard,
  landmark: Landmark,
  wallet: Wallet,
  "badge-check": BadgeCheck,
  "notebook-pen": NotebookPen,
};

export function itemIcon(type: string): LucideIcon {
  return ICONS[getItemType(type)?.icon ?? ""] ?? FileText;
}

const TINTS: Record<string, string> = {
  login: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  secret: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  infrastructure: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  financial: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  other: "bg-muted text-muted-foreground",
};

/** The item's type as a small tinted tile, same shape as the reference stat-card icon. */
export function ItemGlyph({ type, className }: { type: string; className?: string }) {
  const Icon = itemIcon(type);
  const category = getItemType(type)?.category ?? "other";
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg",
        TINTS[category],
        className,
      )}
    >
      <Icon className="size-4" aria-hidden />
    </span>
  );
}
