import type { PageNode } from "@minions/core";
import Placeholder from "@tiptap/extension-placeholder";
import {
  type Editor,
  EditorContent,
  Extension,
  type NodeViewProps,
  NodeViewWrapper,
  type Range,
  ReactNodeViewRenderer,
  ReactRenderer,
  useEditor,
} from "@tiptap/react";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import {
  ChevronRight,
  Code2,
  FileIcon,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  KeyRound,
  Lightbulb,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Table2,
  Type,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { pageFileUrl } from "@/lib/pages/crypto";
import {
  Callout,
  PageFile,
  PageImage,
  PageLink,
  pageSchema,
  VaultItemRef,
} from "@/lib/pages/schema";
import { pageTitle } from "@/lib/pages/tree";
import { usePagesIndex } from "./pages-context";

type PageRef = Pick<PageNode, "id" | "protectedKey">;

// ─── Node views ──────────────────────────────────────────────────────────────

function useFileUrl(page: PageRef, fileId: string | null) {
  const [state, setState] = useState<{ url?: string; name?: string; error?: boolean }>({});
  useEffect(() => {
    if (!fileId) return;
    let alive = true;
    pageFileUrl(page, fileId).then(
      (r) => alive && setState({ url: r.url, name: r.meta.name }),
      () => alive && setState({ error: true }),
    );
    return () => {
      alive = false;
    };
  }, [page, fileId]);
  return state;
}

function ImageView({ node, extension, selected }: NodeViewProps) {
  const page = extension.options.page as PageRef;
  const { url, error } = useFileUrl(page, node.attrs.fileId);
  return (
    <NodeViewWrapper className="my-3" data-drag-handle>
      {url ? (
        <img
          src={url}
          alt={node.attrs.alt}
          className={cn("max-h-[36rem] max-w-full rounded-md", selected && "ring-2 ring-ring")}
        />
      ) : (
        <div className="flex h-32 items-center justify-center rounded-md bg-muted text-muted-foreground text-sm">
          {error ? "Image unavailable" : "Decrypting image…"}
        </div>
      )}
    </NodeViewWrapper>
  );
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function FileView({ node, extension, selected }: NodeViewProps) {
  const page = extension.options.page as PageRef;
  const { url, name, error } = useFileUrl(page, node.attrs.fileId);
  return (
    <NodeViewWrapper className="my-2" data-drag-handle>
      <a
        href={url}
        download={name ?? node.attrs.name}
        className={cn(
          "inline-flex max-w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm no-underline hover:bg-accent",
          selected && "ring-2 ring-ring",
          !url && "pointer-events-none opacity-70",
        )}
      >
        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{name ?? node.attrs.name}</span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {error ? "unavailable" : node.attrs.size ? formatBytes(node.attrs.size) : ""}
        </span>
      </a>
    </NodeViewWrapper>
  );
}

function PageLinkView({ node, extension }: NodeViewProps) {
  const index = usePagesIndex();
  const target = index?.byId.get(node.attrs.pageId);
  const open = extension.options.onOpenPage as (id: string) => void;
  return (
    <NodeViewWrapper as="span" className="page-link">
      <button
        type="button"
        onClick={() => open(node.attrs.pageId)}
        className="inline-flex items-baseline gap-1 rounded px-0.5 font-medium underline decoration-border underline-offset-4 hover:bg-accent"
      >
        <span aria-hidden>
          {target?.icon ??
            (target?.kind === "database" ? (
              <Table2 className="inline size-3.5" />
            ) : (
              <FileText className="inline size-3.5" />
            ))}
        </span>
        {target ? pageTitle(target) : "Missing page"}
      </button>
    </NodeViewWrapper>
  );
}

function VaultItemView({ node, extension }: NodeViewProps) {
  const open = extension.options.onOpenItem as (id: string) => void;
  return (
    <NodeViewWrapper as="span">
      <button
        type="button"
        onClick={() => open(node.attrs.itemId)}
        title="Open in the vault"
        className="inline-flex items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 align-baseline text-sm hover:bg-accent"
      >
        <KeyRound className="size-3 text-emerald-600" />
        {node.attrs.label || "Vault item"}
      </button>
    </NodeViewWrapper>
  );
}

// ─── Slash menu ──────────────────────────────────────────────────────────────

interface SlashItem {
  title: string;
  hint: string;
  icon: typeof Type;
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

interface EditorActions {
  pickFile: (
    kind: "image" | "file",
  ) => Promise<{ fileId: string; name: string; size: number } | null>;
  createSubPage: () => Promise<string | null>;
}

function slashItems(actions: EditorActions): SlashItem[] {
  const chain = (e: Editor, r: Range) => e.chain().focus().deleteRange(r);
  return [
    {
      title: "Text",
      hint: "Plain text",
      icon: Type,
      keywords: "paragraph p",
      run: (e, r) => chain(e, r).setParagraph().run(),
    },
    {
      title: "Heading 1",
      hint: "Big section heading",
      icon: Heading1,
      keywords: "h1 title",
      run: (e, r) => chain(e, r).setHeading({ level: 1 }).run(),
    },
    {
      title: "Heading 2",
      hint: "Medium heading",
      icon: Heading2,
      keywords: "h2 subtitle",
      run: (e, r) => chain(e, r).setHeading({ level: 2 }).run(),
    },
    {
      title: "Heading 3",
      hint: "Small heading",
      icon: Heading3,
      keywords: "h3",
      run: (e, r) => chain(e, r).setHeading({ level: 3 }).run(),
    },
    {
      title: "Bulleted list",
      hint: "A simple list",
      icon: List,
      keywords: "ul bullet",
      run: (e, r) => chain(e, r).toggleBulletList().run(),
    },
    {
      title: "Numbered list",
      hint: "A list with numbers",
      icon: ListOrdered,
      keywords: "ol ordered",
      run: (e, r) => chain(e, r).toggleOrderedList().run(),
    },
    {
      title: "To-do list",
      hint: "Track tasks",
      icon: ListChecks,
      keywords: "todo task checkbox",
      run: (e, r) => chain(e, r).toggleTaskList().run(),
    },
    {
      title: "Toggle",
      hint: "Hide content inside",
      icon: ChevronRight,
      keywords: "details collapse fold",
      run: (e, r) => chain(e, r).setDetails().run(),
    },
    {
      title: "Quote",
      hint: "Capture a quote",
      icon: Quote,
      keywords: "blockquote",
      run: (e, r) => chain(e, r).toggleBlockquote().run(),
    },
    {
      title: "Callout",
      hint: "Make it stand out",
      icon: Lightbulb,
      keywords: "note info warning",
      run: (e, r) => chain(e, r).setCallout().run(),
    },
    {
      title: "Code",
      hint: "A code block",
      icon: Code2,
      keywords: "pre snippet",
      run: (e, r) => chain(e, r).toggleCodeBlock().run(),
    },
    {
      title: "Divider",
      hint: "Separate sections",
      icon: Minus,
      keywords: "hr line separator",
      run: (e, r) => chain(e, r).setHorizontalRule().run(),
    },
    {
      title: "Table",
      hint: "Rows and columns",
      icon: Table2,
      keywords: "grid",
      run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      title: "Image",
      hint: "Encrypted on this device",
      icon: ImageIcon,
      keywords: "picture photo upload",
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        void actions.pickFile("image").then((f) => {
          if (f)
            e.chain()
              .focus()
              .insertContent({ type: "pageImage", attrs: { fileId: f.fileId, alt: f.name } })
              .run();
        });
      },
    },
    {
      title: "File",
      hint: "Attach an encrypted file",
      icon: FileIcon,
      keywords: "attachment upload pdf",
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        void actions.pickFile("file").then((f) => {
          if (f) e.chain().focus().insertContent({ type: "pageFile", attrs: f }).run();
        });
      },
    },
    {
      title: "Page",
      hint: "A sub-page inside this one",
      icon: FileText,
      keywords: "subpage child new",
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        void actions.createSubPage().then((id) => {
          if (id)
            e.chain()
              .focus()
              .insertContent([
                { type: "pageLink", attrs: { pageId: id } },
                { type: "text", text: " " },
              ])
              .run();
        });
      },
    },
  ];
}

interface SlashListHandle {
  onKeyDown: (e: KeyboardEvent) => boolean;
}

const SlashList = forwardRef<SlashListHandle, SuggestionProps<SlashItem>>(function SlashList(
  { items, command, clientRect },
  ref,
) {
  const [active, setActive] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter result starts at the top
  useEffect(() => setActive(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (!items.length) return false;
      if (e.key === "ArrowDown") setActive((a) => (a + 1) % items.length);
      else if (e.key === "ArrowUp") setActive((a) => (a - 1 + items.length) % items.length);
      else if (e.key === "Enter") command(items[active]!);
      else return false;
      return true;
    },
  }));
  const rect = clientRect?.();
  if (!rect || !items.length) return null;
  const below = rect.bottom + 320 < window.innerHeight;
  return (
    <div
      role="listbox"
      className="fixed z-50 max-h-80 w-64 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{
        left: Math.min(rect.left, window.innerWidth - 270),
        ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.title}
          type="button"
          role="option"
          aria-selected={i === active}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            command(item);
          }}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
            i === active && "bg-accent",
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
            <item.icon className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm">{item.title}</span>
            <span className="block truncate text-muted-foreground text-xs">{item.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
});

function slashCommand(actions: EditorActions) {
  const all = slashItems(actions);
  return Extension.create({
    name: "slashCommand",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          char: "/",
          // "/heading 2", "/numbered list": queries can have spaces; no match closes the menu.
          allowSpaces: true,
          items: ({ query }) => {
            const q = query.toLowerCase();
            return all.filter((i) => `${i.title} ${i.keywords}`.toLowerCase().includes(q));
          },
          command: ({ editor, range, props }) => props.run(editor, range),
          render: () => {
            let renderer: ReactRenderer<SlashListHandle, SuggestionProps<SlashItem>> | null = null;
            return {
              onStart: (props) => {
                renderer = new ReactRenderer(SlashList, { props, editor: props.editor });
                document.body.appendChild(renderer.element);
              },
              onUpdate: (props) => renderer?.updateProps(props),
              onKeyDown: ({ event }) => {
                if (event.key === "Escape") {
                  renderer?.destroy();
                  renderer?.element.remove();
                  renderer = null;
                  return true;
                }
                return renderer?.ref?.onKeyDown(event) ?? false;
              },
              onExit: () => {
                renderer?.destroy();
                renderer?.element.remove();
                renderer = null;
              },
            };
          },
        }),
      ];
    },
  });
}

// ─── Editor ──────────────────────────────────────────────────────────────────

export interface PageEditorProps {
  page: PageRef;
  doc: unknown;
  editable: boolean;
  onChange: (doc: unknown) => void;
  onOpenPage: (id: string) => void;
  onOpenItem: (id: string) => void;
  actions: EditorActions;
  /** Pasted or dropped images: encrypt and upload, then return the file id. */
  onPasteImage: (file: File) => Promise<string | null>;
  className?: string;
}

/**
 * The block editor for one page. Content is ProseMirror JSON in the page
 * schema; nothing outside it reaches the DOM. Remounted per page (key it by
 * the page id), so node views always know which page key opens their files.
 */
export function PageEditor({
  page,
  doc,
  editable,
  onChange,
  onOpenPage,
  onOpenItem,
  actions,
  onPasteImage,
  className,
}: PageEditorProps) {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const pasteRef = useRef(onPasteImage);
  pasteRef.current = onPasteImage;

  const editor = useEditor({
    extensions: [
      ...pageSchema().filter(
        (e) =>
          ![Callout.name, PageImage.name, PageFile.name, PageLink.name, VaultItemRef.name].includes(
            e.name,
          ),
      ),
      Callout,
      PageImage.extend({
        addOptions: () => ({ page }),
        addNodeView: () => ReactNodeViewRenderer(ImageView),
      }),
      PageFile.extend({
        addOptions: () => ({ page }),
        addNodeView: () => ReactNodeViewRenderer(FileView),
      }),
      PageLink.extend({
        addOptions: () => ({ onOpenPage }),
        addNodeView: () => ReactNodeViewRenderer(PageLinkView, { as: "span" }),
      }),
      VaultItemRef.extend({
        addOptions: () => ({ onOpenItem }),
        addNodeView: () => ReactNodeViewRenderer(VaultItemView, { as: "span" }),
      }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "heading" ? "Heading" : "Type '/' for blocks, or just write…",
      }),
      slashCommand(actions),
    ],
    content: doc as object,
    editable,
    immediatelyRender: true,
    onUpdate: ({ editor: e }) => changeRef.current(e.getJSON()),
    editorProps: {
      attributes: { class: "outline-none", spellcheck: "true" },
      handlePaste: (view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((f) =>
          f.type.startsWith("image/"),
        );
        if (!file) return false;
        void pasteRef.current(file).then((fileId) => {
          if (!fileId) return;
          const node = view.state.schema.nodes.pageImage!.create({ fileId, alt: file.name });
          view.dispatch(view.state.tr.replaceSelectionWith(node));
        });
        return true;
      },
    },
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  if (!editor) return null;
  return <EditorContent editor={editor} className={cn("minions-prose page-prose", className)} />;
}
