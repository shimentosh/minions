import { useNavigate } from "@tanstack/react-router";
import { LogOut, Monitor, Moon, Settings, ShieldAlert, Sun } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { type Theme, useTheme } from "@/lib/theme";
import { toast } from "@/lib/toast";

export function initials(name: string | undefined) {
  return (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** Light / dark / system as one compact segmented control; the menu stays open. */
function ThemeSwitch({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/60 p-0.5"
    >
      {THEMES.map(({ value: v, label, icon: Icon }) => {
        const active = value === v;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => onChange(v)}
            className={cn(
              "flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              active && "bg-background text-foreground shadow-xs ring-1 ring-border",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}

export function UserMenu() {
  const me = useSession((s) => s.me);
  const logout = useSession((s) => s.logout);
  const emergencyLock = useSession((s) => s.emergencyLock);
  const [theme, setTheme] = useTheme();
  const navigate = useNavigate();
  const [confirmEmergency, setConfirmEmergency] = useState(false);

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-full bg-primary font-medium text-[11px] text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {initials(me?.user.name)}
          <span className="sr-only">Account menu</span>
        </MenuTrigger>
        <MenuPopup align="end" className="w-60">
          <div className="px-2 py-1.5">
            <div className="truncate font-medium text-sm">{me?.user.name}</div>
            <div className="truncate text-muted-foreground text-xs">{me?.user.email}</div>
          </div>
          <MenuSeparator />
          <MenuItem onClick={() => void navigate({ to: "/settings" })}>
            <Settings />
            Settings
          </MenuItem>
          <MenuSeparator />
          <div className="flex items-center justify-between gap-2 px-2 py-1">
            <span className="text-muted-foreground text-sm">Theme</span>
            <ThemeSwitch value={theme} onChange={setTheme} />
          </div>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={() => setConfirmEmergency(true)}>
            <ShieldAlert />
            Lock all devices…
          </MenuItem>
          <MenuItem onClick={() => void logout()}>
            <LogOut />
            Sign out
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AlertDialog open={confirmEmergency} onOpenChange={setConfirmEmergency}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Lock all devices?</AlertDialogTitle>
            <AlertDialogDescription>
              Every session is signed out at once: this browser, the extension and the desktop app.
              Each one needs your master password (and two-factor code) to get back in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={async () => {
                try {
                  await emergencyLock();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Lock everything
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
