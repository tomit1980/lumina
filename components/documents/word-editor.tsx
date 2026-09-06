"use client";

import * as React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import mammoth from "mammoth";
import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { tiptapJsonToDocx, type PMNode } from "@/lib/docx-export";
import { arrayBufferToDataUrl, dataUrlToArrayBuffer, MIME } from "@/lib/documents";
import { cn } from "@/lib/utils";
import type { DocumentEditorHandle, DocumentEditorProps } from "./types";

/** Word documents: .docx → HTML (mammoth) → TipTap → .docx (docx). */
export const WordEditor = React.forwardRef<DocumentEditorHandle, DocumentEditorProps>(
  function WordEditor({ attachment, readOnly, onDirty }, ref) {
    const [warnings, setWarnings] = React.useState<string[]>([]);
    const [loaded, setLoaded] = React.useState(false);
    const [showWarnings, setShowWarnings] = React.useState(false);

    const editor = useEditor({
      immediatelyRender: false,
      editable: !readOnly,
      extensions: [
        StarterKit.configure({ link: false, underline: false }),
        Underline,
        Link.configure({ openOnClick: false, autolink: true }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
      ],
      content: "",
      onUpdate: () => onDirty(),
      editorProps: {
        attributes: { class: "doc-prose min-h-full p-8 outline-none" },
      },
    });

    React.useEffect(() => {
      if (!editor) return;
      let cancelled = false;
      (async () => {
        try {
          const arrayBuffer = dataUrlToArrayBuffer(attachment.dataUrl);
          const result = await mammoth.convertToHtml({ arrayBuffer });
          if (cancelled) return;
          editor.commands.setContent(result.value, { emitUpdate: false });
          setWarnings(Array.from(new Set(result.messages.map((m) => m.message))));
        } catch (err) {
          if (!cancelled) setWarnings([`Couldn't read this document: ${String(err)}`]);
        } finally {
          if (!cancelled) setLoaded(true);
        }
      })();
      return () => {
        cancelled = true;
      };
      // The attachment id is the identity of the document being edited.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, attachment.id]);

    React.useImperativeHandle(ref, () => ({
      async getDataUrl() {
        if (!editor) throw new Error("Editor not ready");
        const buf = await tiptapJsonToDocx(editor.getJSON() as unknown as PMNode);
        return arrayBufferToDataUrl(buf, MIME.docx);
      },
    }));

    if (!editor) return null;

    const tool = (
      label: string,
      icon: React.ReactNode,
      active: boolean,
      run: () => void,
      disabled = false
    ) => (
      <Tooltip key={label}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={label}
            aria-pressed={active}
            disabled={disabled || readOnly}
            className={cn("size-7", active && "bg-secondary text-secondary-foreground")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={run}
          >
            {icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );

    const setLink = () => {
      const prev = editor.getAttributes("link").href as string | undefined;
      const url = window.prompt("Link URL", prev ?? "https://");
      if (url === null) return;
      if (url.trim() === "") editor.chain().focus().unsetLink().run();
      else editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
    };

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-0.5 border-b px-3 py-1.5">
          {tool("Undo", <Undo2 className="size-3.5" />, false, () => editor.chain().focus().undo().run(), !editor.can().undo())}
          {tool("Redo", <Redo2 className="size-3.5" />, false, () => editor.chain().focus().redo().run(), !editor.can().redo())}
          <span className="mx-1 h-4 w-px bg-border" />
          {tool("Bold", <Bold className="size-3.5" />, editor.isActive("bold"), () => editor.chain().focus().toggleBold().run())}
          {tool("Italic", <Italic className="size-3.5" />, editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run())}
          {tool("Underline", <UnderlineIcon className="size-3.5" />, editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run())}
          <span className="mx-1 h-4 w-px bg-border" />
          {tool("Heading 1", <Heading1 className="size-3.5" />, editor.isActive("heading", { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run())}
          {tool("Heading 2", <Heading2 className="size-3.5" />, editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
          {tool("Heading 3", <Heading3 className="size-3.5" />, editor.isActive("heading", { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run())}
          <span className="mx-1 h-4 w-px bg-border" />
          {tool("Bullet list", <List className="size-3.5" />, editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run())}
          {tool("Numbered list", <ListOrdered className="size-3.5" />, editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run())}
          {tool("Quote", <Quote className="size-3.5" />, editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run())}
          <span className="mx-1 h-4 w-px bg-border" />
          {tool("Insert table", <TableIcon className="size-3.5" />, editor.isActive("table"), () =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          )}
          {tool("Link", <Link2 className="size-3.5" />, editor.isActive("link"), setLink)}
          {warnings.length > 0 && (
            <button
              type="button"
              className="ml-auto text-[11px] text-amber-700 hover:underline dark:text-amber-300"
              onClick={() => setShowWarnings((s) => !s)}
            >
              Some content couldn&apos;t be imported ({warnings.length})
            </button>
          )}
        </div>
        {showWarnings && (
          <ul className="max-h-24 overflow-y-auto border-b bg-amber-50 px-4 py-2 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30">
          <div className="mx-auto my-6 min-h-[60vh] max-w-3xl rounded-lg border bg-background shadow-sm">
            {loaded ? (
              <EditorContent editor={editor} />
            ) : (
              <p className="p-8 text-sm text-muted-foreground">Opening document…</p>
            )}
          </div>
        </div>
      </div>
    );
  }
);
