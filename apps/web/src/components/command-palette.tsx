import { getItemType, type Page, type VaultItemSummary } from "@minions/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, CornerDownLeftIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { PageIcon } from "@/components/pages/page-tree";
import { SnippetLine } from "@/components/pages/snippet-line";
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
import { errorMessage, get } from "@/lib/api";
import { useShowArchived } from "@/lib/archive";
import { ItemGlyph } from "@/lib/item-icons";
import { usePageActions, usePageTree } from "@/lib/pages/queries";
import { type Snippet, searchAllPages, usePageSearchIndex } from "@/lib/pages/search";
import { ancestorsOf, type PageEntry, pageTitle } from "@/lib/pages/tree";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useUi } from "@/lib/ui-store";

interface PaletteItem {
  value: string;
  label: string;
  keywords?: string;
  hint?: string;
  shortcut?: string;
  itemType?: string;
  page?: PageEntry;
  snippet?: Snippet | null;
  /** Already matched (pages are searched here, on the device): skips the text filter. */
  matched?: boolean;
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
  // Archived items only when the person chose to show them.
  const showArchived = useShowArchived((s) => s.show);
  const { data } = useQuery({
    queryKey: ["palette", debounced, showArchived],
    enabled: open,
    queryFn: () =>
      get<Page<VaultItemSummary>>("/vault/items", {
        q: debounced || undefined,
        sort: debounced ? "updated" : "recent",
        archived: showArchived ? "include" : undefined,
        limit: 8,
      }),
    placeholderData: (prev) => prev,
  });

  // Pages are decrypted on this device: titles at once, content as the index fills in.
  const { visible: pages, index: pageIndex } = usePageTree();
  const pageActions = usePageActions();
  const { indexed } = usePageSearchIndex(pages, open);
  const onPages = useRouterState({ select: (s) => s.location.pathname.startsWith("/pages") });
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run as the index fills in
  const pageItems = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    const list = q
      ? searchAllPages(pages ?? [], q, 8)
      : [...(pages ?? [])]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 5)
          .map((page) => ({ page, snippet: null }));
    return list.map(({ page, snippet }) => ({
      value: `page-${page.id}`,
      label: pageTitle(page),
      hint: ancestorsOf(pageIndex, page.id).map(pageTitle).join(" / ") || undefined,
      page,
      snippet,
      matched: true,
      onRun: () => void navigate({ to: "/pages/$pageId", params: { pageId: page.id } }),
    }));
  }, [pages, pageIndex, query, indexed, navigate]);

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
    const pageGroup = {
      value: "pages",
      label: query.trim() ? "Pages" : "Recent pages",
      items: pageItems,
    };
    const itemGroup = { value: "items", label: debounced ? "Vault" : "Recently used", items };
    return [
      ...(onPages ? [pageGroup, itemGroup] : [itemGroup, pageGroup]),
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
            value: "new-page",
            label: "Create page",
            keywords: "page doc wiki notion new write",
            onRun: () =>
              void pageActions.create({ parentId: null }).then(
                (id) => navigate({ to: "/pages/$pageId", params: { pageId: id } }),
                (e) => toast.error(errorMessage(e)),
              ),
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
            value: "go-pages",
            label: "All pages",
            keywords: "pages docs wiki notion",
            onRun: () => void navigate({ to: "/pages" }),
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
  }, [
    data,
    debounced,
    query,
    pageItems,
    onPages,
    pageActions,
    navigate,
    openEditor,
    setCapture,
    lock,
  ]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup instant>
        <Command
          items={groups}
          value={query}
          onValueChange={(v: string) => setQuery(v)}
          filter={(item: unknown, q: string) => {
            const p = item as PaletteItem;
            return (
              !q ||
              !!p.matched ||
              `${p.label} ${p.keywords ?? ""}`.toLowerCase().includes(q.toLowerCase())
            );
          }}
        >
          <CommandInput placeholder="Search the vault and pages, or type a command…" />
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
                          {item.page && (
                            <span className="flex size-6 shrink-0 items-center justify-center">
                              <PageIcon page={item.page} className="text-muted-foreground" />
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{item.label}</span>
                            {item.snippet && <SnippetLine snippet={item.snippet} />}
                          </span>
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
