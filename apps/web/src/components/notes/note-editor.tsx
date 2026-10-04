import type { NoteDetail } from "@minions/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Strikethrough,
  Table2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/cn";

function Toolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      code: e.isActive("codeBlock"),
      quote: e.isActive("blockquote"),
      link: e.isActive("link"),
    }),
  });
  const btn = (pressed: boolean, label: string, Icon: typeof Bold, run: () => void) => (
    <Toggle size="sm" pressed={pressed} onPressedChange={run} aria-label={label} title={label}>
      <Icon />
    </Toggle>
  );
  const chain = () => editor.chain().focus();
  return (
    <div className="flex flex-wrap items-center gap-0.5">
      {btn(state.bold, "Bold", Bold, () => chain().toggleBold().run())}
      {btn(state.italic, "Italic", Italic, () => chain().toggleItalic().run())}
      {btn(state.strike, "Strikethrough", Strikethrough, () => chain().toggleStrike().run())}
      <span className="mx-1 h-4 w-px bg-border" />
      {btn(state.h1, "Heading 1", Heading1, () => chain().toggleHeading({ level: 1 }).run())}
      {btn(state.h2, "Heading 2", Heading2, () => chain().toggleHeading({ level: 2 }).run())}
      {btn(state.h3, "Heading 3", Heading3, () => chain().toggleHeading({ level: 3 }).run())}
      <span className="mx-1 h-4 w-px bg-border" />
      {btn(state.bullet, "Bulleted list", List, () => chain().toggleBulletList().run())}
      {btn(state.ordered, "Numbered list", ListOrdered, () => chain().toggleOrderedList().run())}
      {btn(state.task, "Checklist", ListChecks, () => chain().toggleTaskList().run())}
      <span className="mx-1 h-4 w-px bg-border" />
      {btn(state.code, "Code block", Code2, () => chain().toggleCodeBlock().run())}
      {btn(state.quote, "Quote", Quote, () => chain().toggleBlockquote().run())}
      {btn(state.link, "Link", Link2, () => {
        if (editor.isActive("link")) return chain().unsetLink().run();
        const url = window.prompt("Link URL");
        if (url && /^(https?:\/\/|mailto:)/i.test(url))
          chain().extendMarkRange("link").setLink({ href: url }).run();
      })}
      {btn(false, "Insert table", Table2, () =>
        chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      )}
    </div>
  );
}

/**
 * Rich text over decrypted HTML. Only ProseMirror's schema reaches the DOM,
 * so pasted or stored markup outside it (scripts, handlers) is dropped.
 */
export function NoteEditor({
  note,
  html,
  onChange,
  className,
}: {
  note: NoteDetail;
  html: string;
  onChange: (html: string) => void;
  className?: string;
}) {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const [ready, setReady] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true, protocols: ["http", "https", "mailto"] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({ placeholder: "Write something…" }),
    ],
    content: html,
    immediatelyRender: true,
    onCreate: () => setReady(true),
    onUpdate: ({ editor: e }) => changeRef.current(e.getHTML()),
    editorProps: { attributes: { class: "outline-none", spellcheck: "true" } },
  });

  // Switching notes reuses the editor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when switching notes; html changes on every keystroke
  useEffect(() => {
    if (editor && ready && editor.getHTML() !== html)
      editor.commands.setContent(html, { emitUpdate: false });
  }, [note.id]);

  if (!editor) return null;
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="sticky top-0 z-10 border-border/60 border-b bg-card/95 px-4 py-1.5 backdrop-blur md:px-8">
        <Toolbar editor={editor} />
      </div>
      <EditorContent editor={editor} className="minions-prose min-h-0 flex-1 px-4 py-4 md:px-8" />
    </div>
  );
}
