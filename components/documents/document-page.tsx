"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, Download, Eye, Loader2, Save, Share2, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DocumentViewer } from "@/components/documents/viewer";
import { useUI } from "@/components/ui-context";
import { formatBytes, MAX_ATTACHMENT_BYTES } from "@/lib/attachments";
import { dataUrlByteLength, documentKind, isEditable, KIND_META } from "@/lib/documents";
import { projectHref } from "@/lib/routes";
import { useStore } from "@/lib/store";
import type { Project } from "@/lib/types";
import type { DocumentEditorHandle, DocumentEditorProps } from "./types";

// Editors pull in SheetJS / mammoth / docx / TipTap — only load them when a file is opened.
const editorLoading = () => (
  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
    <Loader2 className="mr-2 size-4 animate-spin" /> Loading editor…
  </div>
);
type EditorComponent = React.ForwardRefExoticComponent<
  DocumentEditorProps & React.RefAttributes<DocumentEditorHandle>
>;
const MarkdownEditor = dynamic(
  () => import("@/components/documents/markdown-editor").then((m) => m.MarkdownEditor),
  { ssr: false, loading: editorLoading }
) as EditorComponent;
const SpreadsheetEditor = dynamic(
  () => import("@/components/documents/spreadsheet-editor").then((m) => m.SpreadsheetEditor),
  { ssr: false, loading: editorLoading }
) as EditorComponent;
const WordEditor = dynamic(
  () => import("@/components/documents/word-editor").then((m) => m.WordEditor),
  { ssr: false, loading: editorLoading }
) as EditorComponent;

/** Full-page document editor/viewer for one project file (`?file=`). */
export function DocumentPage({
  project,
  fileId,
  canManageFiles,
}: {
  project: Project;
  fileId: string;
  canManageFiles: boolean;
}) {
  const router = useRouter();
  const { state, currentUser, updateProject, can } = useStore();
  const { openShareFileDialog } = useUI();
  const editorRef = React.useRef<DocumentEditorHandle>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [confirmLeave, setConfirmLeave] = React.useState(false);

  const file = project.attachments.find((a) => a.id === fileId);
  const kind = file ? documentKind(file) : "other";
  const editable = file ? isEditable(kind) : false;
  const readOnly = !canManageFiles;
  const editor = file?.editedBy
    ? state.users.find((u) => u.id === file.editedBy)
    : undefined;

  const save = React.useCallback(async () => {
    if (!file || !editorRef.current || readOnly || saving) return;
    setSaving(true);
    try {
      const dataUrl = await editorRef.current.getDataUrl();
      const size = dataUrlByteLength(dataUrl);
      if (size > MAX_ATTACHMENT_BYTES) {
        toast.error(
          `This file is ${formatBytes(size)} — max is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`
        );
        return;
      }
      updateProject(project.id, {
        attachments: project.attachments.map((a) =>
          a.id === file.id
            ? { ...a, dataUrl, size, editedBy: currentUser.id, editedAt: Date.now() }
            : a
        ),
      });
      setDirty(false);
      toast.success(`Saved ${file.name}`);
    } catch (err) {
      toast.error("Couldn't save", { description: String(err) });
    } finally {
      setSaving(false);
    }
  }, [file, readOnly, saving, updateProject, project.id, project.attachments, currentUser.id]);

  // ⌘S / Ctrl+S saves; warn before a reload with unsaved edits.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [save, dirty]);

  const leave = () => {
    if (dirty) setConfirmLeave(true);
    else router.push(projectHref(project.id));
  };

  if (!file) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-base font-semibold">File not found</h2>
        <p className="text-sm text-muted-foreground">It may have been removed from the project.</p>
        <Button asChild variant="outline" size="sm">
          <Link href={projectHref(project.id)}>
            <ArrowLeft className="size-4" /> Back to {project.name}
          </Link>
        </Button>
      </div>
    );
  }

  const onDirty = () => setDirty(true);
  const editorProps: DocumentEditorProps = { attachment: file, kind, readOnly, onDirty };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" onClick={leave} aria-label="Back to project">
              <ArrowLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Back to {project.name}</TooltipContent>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={projectHref(project.id)}
              className="truncate text-[12px] text-muted-foreground hover:underline"
            >
              {project.emoji} {project.name}
            </Link>
            <span className="text-muted-foreground">›</span>
            <h1 className="truncate text-sm font-semibold">{file.name}</h1>
            <Badge variant="secondary" className="text-[10px]">
              {KIND_META[kind].label}
            </Badge>
            {dirty && (
              <span className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
                <span className="size-1.5 rounded-full bg-current" /> Unsaved changes
              </span>
            )}
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {formatBytes(file.size)}
            {file.editedAt && (
              <>
                {" · "}edited {editor ? `by ${editor.name} ` : ""}
                {formatDistanceToNow(file.editedAt, { addSuffix: true })}
              </>
            )}
          </p>
        </div>
        {editable && !readOnly && (
          <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="ghost" size="icon" className="size-8">
              <a href={file.dataUrl} download={file.name} aria-label="Download">
                <Download className="size-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download</TooltipContent>
        </Tooltip>
        {can("message.send") && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Share to chat"
                onClick={() => openShareFileDialog(project.id, file.id)}
              >
                <Share2 className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Share to chat</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" onClick={leave} aria-label="Close">
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </header>

      {editable && readOnly && (
        <p className="flex items-center gap-1.5 border-b bg-muted/50 px-4 py-1.5 text-[11px] text-muted-foreground">
          <Eye className="size-3" /> You have view-only access — download the file to edit it elsewhere.
        </p>
      )}
      {(kind === "word" || kind === "spreadsheet") && !readOnly && (
        <p className="border-b bg-muted/50 px-4 py-1.5 text-[11px] text-muted-foreground">
          Basic-fidelity editing: text, headings, lists, tables and cell values are kept on save;
          images, page layout, styles, comments and edited formulas are not.
        </p>
      )}

      <div className="min-h-0 flex-1">
        {kind === "markdown" || kind === "text" ? (
          <MarkdownEditor ref={editorRef} {...editorProps} />
        ) : kind === "spreadsheet" ? (
          <SpreadsheetEditor ref={editorRef} {...editorProps} />
        ) : kind === "word" ? (
          <WordEditor ref={editorRef} {...editorProps} />
        ) : (
          <DocumentViewer attachment={file} kind={kind} />
        )}
      </div>

      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="Discard changes?"
        description={`${file.name} has unsaved edits. Leave without saving?`}
        confirmLabel="Discard"
        onConfirm={() => {
          setDirty(false);
          setConfirmLeave(false);
          router.push(projectHref(project.id));
        }}
      />
    </div>
  );
}
