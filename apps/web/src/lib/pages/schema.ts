import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { type Extensions, mergeAttributes, Node } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

/**
 * The page document schema. The editor and the Notion importer both use it,
 * so whatever the importer produces is exactly what the editor can show. Only
 * these nodes and marks can ever reach the DOM: anything else in pasted or
 * imported HTML is dropped by ProseMirror's parser.
 *
 * Images and attachments refer to encrypted page files by id; they have no
 * src, so nothing in a page can make the browser fetch a remote URL.
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: { setCallout: (icon?: string) => ReturnType };
  }
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      icon: {
        default: "💡",
        parseHTML: (el) => el.getAttribute("data-icon") || "💡",
        renderHTML: (attrs) => ({ "data-icon": attrs.icon }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-callout]" }, { tag: "aside" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-callout": "", class: "callout" }), 0];
  },
  addCommands() {
    return {
      setCallout:
        (icon = "💡") =>
        ({ commands }) =>
          commands.wrapIn(this.name, { icon }),
    };
  },
});

export const PageImage = Node.create({
  name: "pageImage",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      fileId: { default: null, parseHTML: (el) => el.getAttribute("data-file-id") },
      alt: { default: "", parseHTML: (el) => el.getAttribute("alt") ?? "" },
    };
  },
  parseHTML() {
    return [{ tag: "img[data-file-id]" }];
  },
  renderHTML({ node }) {
    return ["img", { "data-file-id": node.attrs.fileId, alt: node.attrs.alt }];
  },
});

export const PageFile = Node.create({
  name: "pageFile",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      fileId: { default: null, parseHTML: (el) => el.getAttribute("data-file-id") },
      name: { default: "file", parseHTML: (el) => el.getAttribute("data-name") ?? "file" },
      size: { default: 0, parseHTML: (el) => Number(el.getAttribute("data-size") ?? 0) },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-page-file]" }];
  },
  renderHTML({ node }) {
    return [
      "div",
      {
        "data-page-file": "",
        "data-file-id": node.attrs.fileId,
        "data-name": node.attrs.name,
        "data-size": String(node.attrs.size),
      },
      node.attrs.name,
    ];
  },
});

/** A link to another page by id: it always shows that page's current title. */
export const PageLink = Node.create({
  name: "pageLink",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { pageId: { default: null, parseHTML: (el) => el.getAttribute("data-page-id") } };
  },
  parseHTML() {
    return [{ tag: "a[data-page-id]" }, { tag: "span[data-page-id]" }];
  },
  renderHTML({ node }) {
    return ["a", { "data-page-id": node.attrs.pageId, href: `/pages/${node.attrs.pageId}` }];
  },
  renderText: () => "",
});

/** A vault item (login, API key…) shown in a page. The secret stays in the vault. */
export const VaultItemRef = Node.create({
  name: "vaultItem",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      itemId: { default: null, parseHTML: (el) => el.getAttribute("data-item-id") },
      label: { default: "", parseHTML: (el) => el.textContent ?? "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-vault-item]" }];
  },
  renderHTML({ node }) {
    return ["span", { "data-vault-item": "", "data-item-id": node.attrs.itemId }, node.attrs.label];
  },
  renderText: ({ node }) => node.attrs.label,
});

/** Schema-level extensions (no node views): for parsing and generateJSON. */
export function pageSchema(): Extensions {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, protocols: ["http", "https", "mailto"] },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Details.configure({ persist: true }),
    DetailsSummary,
    DetailsContent,
    Callout,
    PageImage,
    PageFile,
    PageLink,
    VaultItemRef,
  ];
}

export const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
