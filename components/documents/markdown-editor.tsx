"use client";

import * as React from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { Button } from "@/components/ui/button";
import { dataUrlToText, textToDataUrl } from "@/lib/documents";
import { cn } from "@/lib/utils";
import type { DocumentEditorHandle, DocumentEditorProps } from "./types";

type Mode = "write" | "split" | "preview";

/** Markdown (with live preview) and plain-text editing. */
export const MarkdownEditor = React.forwardRef<DocumentEditorHandle, DocumentEditorProps>(
  function MarkdownEditor({ attachment, kind, readOnly, onDirty }, ref) {
    const [text, setText] = React.useState(() => dataUrlToText(attachment.dataUrl));
    const isMarkdown = kind === "markdown";
    const [mode, setMode] = React.useState<Mode>(isMarkdown ? "split" : "write");

    React.useImperativeHandle(ref, () => ({
      async getDataUrl() {
        return textToDataUrl(text, attachment.type || (isMarkdown ? "text/markdown" : "text/plain"));
      },
    }));

    const html = React.useMemo(() => {
      if (!isMarkdown || mode === "write") return "";
      const raw = marked.parse(text, { async: false, gfm: true, breaks: false }) as string;
      return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
    }, [text, isMarkdown, mode]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const el = e.currentTarget;
        const { selectionStart, selectionEnd } = el;
        const next = `${text.slice(0, selectionStart)}  ${text.slice(selectionEnd)}`;
        setText(next);
        onDirty();
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = selectionStart + 2;
        });
      }
    };

    return (
      <div className="flex h-full min-h-0 flex-col">
        {isMarkdown && (
          <div className="flex items-center gap-1 border-b px-4 py-1.5">
            {(["write", "split", "preview"] as Mode[]).map((m) => (
              <Button
                key={m}
                type="button"
                size="sm"
                variant={mode === m ? "secondary" : "ghost"}
                className="h-7 px-2.5 text-xs capitalize"
                onClick={() => setMode(m)}
              >
                {m}
              </Button>
            ))}
            <span className="ml-auto text-[11px] text-muted-foreground">
              Markdown · {text.length.toLocaleString()} chars
            </span>
          </div>
        )}
        <div className={cn("grid min-h-0 flex-1", mode === "split" ? "grid-cols-2" : "grid-cols-1")}>
          {mode !== "preview" && (
            <textarea
              value={text}
              readOnly={readOnly}
              spellCheck={isMarkdown}
              onChange={(e) => {
                setText(e.target.value);
                onDirty();
              }}
              onKeyDown={onKeyDown}
              className={cn(
                "h-full w-full resize-none bg-background p-5 font-mono text-[13px] leading-relaxed outline-none",
                mode === "split" && "border-r",
                readOnly && "cursor-default text-muted-foreground"
              )}
              placeholder={isMarkdown ? "# Start writing…" : ""}
            />
          )}
          {mode !== "write" && (
            <div
              className="doc-prose h-full overflow-y-auto p-6"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      </div>
    );
  }
);
