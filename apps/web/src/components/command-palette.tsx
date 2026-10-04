import { getItemType, type Page, type VaultItemSummary } from "@minions/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, CornerDownLeftIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { get } from "@/lib/api";
import { ItemGlyph } from "@/lib/item-icons";
import { useSession } from "@/lib/session";
import { useUi } from "@/lib/ui-store";

interface PaletteItem {
  value: string;
  label: string;
  keywords?: string;
  hint?: string;
  shortcut?: string;
  itemType?: string;
  onRun: () => void;
}

interface PaletteGroup {
  value: string;
  label: string;
  items: PaletteItem[];
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);
  const setCapture = useUi((s) => s.setCapture);
  const openEditor = useUi((s) => s.openEditor);
  const lock = useSession((s) => s.lock);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useUi.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 150);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Server-side search over safe metadata; recent items when the query is empty.
  const { data } = useQuery({
    queryKey: ["palette", debounced],
    enabled: open,
    queryFn: () =>
      get<Page<VaultItemSummary>>("/vault/items", {
        q: debounced || undefined,
        sort: debounced ? "updated" : "recent",
        limit: 8,
      }),
    placeholderData: (prev) => prev,
  });

  const run = useCallback(
    (fn: () => void) => {
      setOpen(false);
      fn();
    },
    [setOpen],
  );

  const groups = useMemo<PaletteGroup[]>(() => {
    const items: PaletteItem[] = (data?.items ?? []).map((i) => ({
      value: `item-${i.id}`,
      label: i.name,
      hint: i.subtitle ?? getItemType(i.type)?.label,
      itemType: i.type,
      // Already matched by the server: always passes the local filter.
      keywords: `${debounced} ${i.subtitle ?? ""} ${i.host ?? ""} ${i.provider ?? ""} ${i.project?.name ?? ""}`,
      onRun: () => void navigate({ to: "/vault", search: { item: i.id } }),
    }));
    return [
      { value: "items", label: debounced ? "Vault" : "Recently used", items },
      {
        value: "create",
        label: "Create",
        items: [
          {
            value: "new-login",
            label: "Create credential",
            keywords: "login password new add",
            onRun: () => openEditor({ type: "LOGIN" }),
          },
          {
            value: "new-api",
            label: "Create API key",
            keywords: "secret token new",
            onRun: () => openEditor({ type: "API_KEY" }),
          },
          {
            value: "new-item",
            label: "Create item…",
            keywords: "new add server database card bank ssh",
            onRun: () => openEditor({}),
          },
          {
            value: "new-note",
            label: "Create note",
            keywords: "note new write",
            onRun: () => void navigate({ to: "/notes", search: { note: "new" } }),
          },
          {
            value: "new-project",
            label: "Create project",
            keywords: "project new",
            onRun: () => void navigate({ to: "/projects" }),
          },
          {
            value: "capture",
            label: "Quick capture",
            keywords: "paste detect smart",
            onRun: () => setCapture(true),
          },
        ],
      },
      {
        value: "go",
        label: "Go to",
        items: [
          {
            value: "go-generator",
            label: "Generate password",
            keywords: "generator random",
            onRun: () => void navigate({ to: "/generator" }),
          },
          {
            value: "go-authenticator",
            label: "Authenticator (2FA codes)",
            keywords: "2fa totp otp codes google authenticator",
            onRun: () => void navigate({ to: "/authenticator" }),
          },
          {
            value: "go-shares",
            label: "Shared links",
            keywords: "share link send one-time expire",
            onRun: () => void navigate({ to: "/shares" }),
          },
          {
            value: "go-security",
            label: "Security Center",
            keywords: "health weak reused 2fa score",
            onRun: () => void navigate({ to: "/security" }),
          },
          {
            value: "go-activity",
            label: "Recent activity",
            keywords: "log history audit",
            onRun: () => void navigate({ to: "/activity" }),
          },
          {
            value: "go-notes",
            label: "Notes",
            keywords: "notes",
            onRun: () => void navigate({ to: "/notes" }),
          },
          {
            value: "go-devices",
            label: "Devices & sessions",
            keywords: "devices sessions revoke",
            onRun: () => void navigate({ to: "/devices" }),
          },
          {
            value: "go-import",
            label: "Import",
            keywords: "csv notion bitwarden chrome",
            onRun: () => void navigate({ to: "/import" }),
          },
          {
            value: "go-settings",
            label: "Settings",
            keywords: "preferences auto lock 2fa password",
            onRun: () => void navigate({ to: "/settings" }),
          },
          { value: "lock", label: "Lock vault", keywords: "lock close", onRun: () => void lock() },
        ],
      },
    ].filter((g) => g.items.length > 0);
  }, [data, debounced, navigate, openEditor, setCapture, lock]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup instant>
        <Command
          items={groups}
          value={query}
          onValueChange={(v: string) => setQuery(v)}
          filter={(item: unknown, q: string) => {
            const p = item as PaletteItem;
            return !q || `${p.label} ${p.keywords ?? ""}`.toLowerCase().includes(q.toLowerCase());
          }}
        >
          <CommandInput placeholder="Search the vault or type a command…" />
          <CommandPanel>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandList>
              {(group: PaletteGroup, index: number) => (
                <Fragment key={group.value}>
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.label}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: PaletteItem) => (
                        <CommandItem
                          key={item.value}
                          value={item}
                          onClick={() => run(item.onRun)}
                          className="gap-2.5 px-3"
                        >
                          {item.itemType && (
                            <ItemGlyph type={item.itemType} className="size-6 [&_svg]:size-3.5" />
                          )}
                          <span className="flex-1 truncate">{item.label}</span>
                          {item.hint && (
                            <span className="max-w-[40%] truncate text-muted-foreground text-xs">
                              {item.hint}
                            </span>
                          )}
                          {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                  {index < groups.length - 1 && <CommandSeparator />}
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <KbdGroup>
                  <Kbd>
                    <ArrowUpIcon />
                  </Kbd>
                  <Kbd>
                    <ArrowDownIcon />
                  </Kbd>
                </KbdGroup>
                <span>Navigate</span>
              </div>
              <div className="flex items-center gap-2">
                <Kbd>
                  <CornerDownLeftIcon />
                </Kbd>
                <span>Open</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Kbd>Esc</Kbd>
              <span>Close</span>
            </div>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
