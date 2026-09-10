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
import { useAttachmentUrl } from "@/components/attachment-url";
import { DownloadLink } from "@/components/download-link";
import {
  attachmentBytes,
  formatBytes,
  isStorageRef,
  saveAttachmentBytes,
} from "@/lib/attachments";
import { documentKind, isEditable, KIND_META } from "@/lib/documents";
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
  const download = useAttachmentUrl(file?.dataUrl ?? "", file?.name);

  // THE LOAD END. The three editors parse a data: URL and always have; what
  // changed in Task 10 is only where that URL comes from. Locally it is the
  // reference itself, resolved on the first render with no effect and no
  // network — the demo is untouched. On the real backend the bytes are
  // downloaded from Storage once and handed down the same way, which is why
  // not one line inside markdown-editor / spreadsheet-editor / word-editor
  // needed to change: they still receive an `Attachment` whose `dataUrl` is
  // the file.
  //
  // `null` means "still loading" and is distinct from a failure, so a slow
  // download shows a spinner rather than an error and an error is never
  // mistaken for an empty document — which for an editor would mean saving
  // emptiness over the real file.
  const ref = file?.dataUrl ?? "";
  const mime = file?.type ?? "";
  const [bytes, setBytes] = React.useState<
    { ok: true; url: string } | { ok: false; error: string } | null
  >(null);
  React.useEffect(() => {
    if (!ref || !editable) {
      setBytes(null);
      return;
    }
    let cancelled = false;
    setBytes(null);
    void attachmentBytes(ref, mime).then((result) => {
      if (!cancelled) setBytes(result);
    });
    return () => {
      cancelled = true;
    };
  }, [ref, mime, editable]);

  const save = React.useCallback(async () => {
    if (!file || !editorRef.current || readOnly || saving || !dirty) return;
    setSaving(true);
    try {
      // THE SAVE END, and the only part of saving that Task 10 changed. The
      // editor still hands back a data: URL — its internals are untouched —
      // and `saveAttachmentBytes` decides what that means: on the local
      // backend the bytes ARE the reference and it passes them straight
      // through; on the real one it overwrites the object in Storage in place
      // and hands back the same path, so every link to the file stays valid.
      //
      // It also owns the size check now, so the cap is enforced against the
      // real byte count rather than the base64 length, in exactly one place.
      const dataUrl = await editorRef.current.getDataUrl();
      const editedAt = Date.now();
      const stored = await saveAttachmentBytes(file, dataUrl, currentUser.id, editedAt);
      if (!stored.ok) {
        toast.error("Couldn't save", { description: stored.error });
        return;
      }
      // WHAT IS ALREADY IRREVERSIBLE BY THIS POINT, and it decides what the
      // next failure is allowed to say. When the bytes live outside the
      // workspace blob (a Storage reference rather than a `data:` URL), the
      // call above has ALREADY replaced the file's previous contents in
      // place, and there is no version history to get them back from. The
      // store's default rollback toast — "Your change has been undone" — is
      // then the exact opposite of the truth, which is QA-105. On the local
      // backend nothing is written until the project is persisted below, so
      // the default is accurate there and is left alone.
      const replaced = isStorageRef(stored.dataUrl);
      const ok = await updateProject(
        project.id,
        {
          attachments: project.attachments.map((a) =>
            a.id === file.id
              ? {
                  ...a,
                  dataUrl: stored.dataUrl,
                  size: stored.size,
                  editedBy: currentUser.id,
                  editedAt,
                }
              : a
          ),
        },
        replaced
          ? {
              undone: `${file.name} itself was saved — only the project's record of its size and editor is out of date. Reload to refresh it.`,
            }
          : undefined
      );
      // The store may deny the write (e.g. access was revoked mid-edit) —
      // in that case it already shows the reason via toast, so don't also
      // claim success and don't clear `dirty` on an edit that was never
      // persisted (the same lie QA-003b was about, through a different door).
      if (ok) {
        setDirty(false);
        toast.success(`Saved ${file.name}`);
      } else if (replaced) {
        // The editor's contents ARE what the server now holds, so leaving
        // "Unsaved changes" up would be the same lie in the other direction:
        // it would invite the user to press Save again over a file that
        // already matches, and warn them about losing edits that landed.
        setDirty(false);
      }
    } catch (err) {
      toast.error("Couldn't save", { description: String(err) });
    } finally {
      setSaving(false);
    }
  }, [file, readOnly, saving, dirty, updateProject, project.id, project.attachments, currentUser.id]);

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
  // The editors get an attachment whose `dataUrl` is the bytes, exactly as
  // they always did. `loaded` is only non-null once they are in hand.
  const loaded =
    editable && bytes?.ok ? { ...file, dataUrl: bytes.url } : null;
  const editorProps: DocumentEditorProps | null = loaded
    ? { attachment: loaded, kind, readOnly, onDirty }
    : null;

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
              <DownloadLink state={download} fileName={file.name} aria-label="Download">
                <Download className="size-4" />
              </DownloadLink>
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
        {!editable ? (
          <DocumentViewer attachment={file} kind={kind} />
        ) : bytes === null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading {file.name}…
          </div>
        ) : !bytes.ok ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <h2 className="text-base font-semibold">Couldn&apos;t open this file</h2>
            <p className="max-w-md text-sm text-muted-foreground">{bytes.error}</p>
          </div>
        ) : kind === "markdown" || kind === "text" ? (
          <MarkdownEditor ref={editorRef} {...editorProps!} />
        ) : kind === "spreadsheet" ? (
          <SpreadsheetEditor ref={editorRef} {...editorProps!} />
        ) : (
          <WordEditor ref={editorRef} {...editorProps!} />
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
