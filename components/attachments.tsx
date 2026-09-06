"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import { Download, FileCode2, FileImage, FileSpreadsheet, FileText, Paperclip, Share2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { formatBytes, MAX_ATTACHMENT_BYTES, readFileAsAttachment } from "@/lib/attachments";
import { canOpen, documentKind, type DocumentKind } from "@/lib/documents";
import { useStore } from "@/lib/store";
import type { Attachment } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Icon for a file kind (images get a thumbnail instead). */
export function KindIcon({ kind, className }: { kind: DocumentKind; className?: string }) {
  const Icon =
    kind === "spreadsheet"
      ? FileSpreadsheet
      : kind === "image"
        ? FileImage
        : kind === "text"
          ? FileCode2
          : FileText;
  return <Icon className={className} />;
}

function AttachmentRow({
  attachment,
  disabled,
  onRemove,
  onShare,
  onOpen,
}: {
  attachment: Attachment;
  disabled: boolean;
  onRemove: () => void;
  onShare?: () => void;
  onOpen?: () => void;
}) {
  const { state } = useStore();
  const uploader = state.users.find((u) => u.id === attachment.uploadedBy);
  const isImage = attachment.type.startsWith("image/");
  const kind = documentKind(attachment);
  const openable = onOpen !== undefined && canOpen(kind);
  const meta = (
    <div className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
      <span>{formatBytes(attachment.size)}</span>
      {uploader && (
        <>
          <span>·</span>
          <UserAvatar user={uploader} size="xs" />
          <span className="truncate">{uploader.name}</span>
        </>
      )}
      <span>·</span>
      <span>{formatDistanceToNow(attachment.editedAt ?? attachment.uploadedAt, { addSuffix: true })}</span>
    </div>
  );

  return (
    <div className="flex items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2">
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.dataUrl}
          alt=""
          className="size-8 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <KindIcon kind={kind} className="size-4 text-muted-foreground" />
        </div>
      )}
      {openable ? (
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left hover:underline"
          title="Open"
        >
          <div className="truncate text-[13px] font-medium">{attachment.name}</div>
          {meta}
        </button>
      ) : (
        <a
          href={attachment.dataUrl}
          download={attachment.name}
          className="min-w-0 flex-1 hover:underline"
          title="Download"
        >
          <div className="truncate text-[13px] font-medium">{attachment.name}</div>
          {meta}
        </a>
      )}
      {openable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground">
              <a href={attachment.dataUrl} download={attachment.name} aria-label={`Download ${attachment.name}`}>
                <Download className="size-3.5" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download</TooltipContent>
        </Tooltip>
      )}
      {onShare && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground"
              onClick={onShare}
              aria-label={`Share ${attachment.name} to chat`}
            >
              <Share2 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Share to chat</TooltipContent>
        </Tooltip>
      )}
      {!disabled && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/** Attachment list + uploader, shared between tasks and projects. */
export function AttachmentsField({
  attachments,
  onAdd,
  onRemove,
  onShare,
  onOpen,
  disabled = false,
}: {
  attachments: Attachment[];
  /** Called once per upload batch with every file that was read successfully. */
  onAdd: (attachments: Attachment[]) => void;
  onRemove: (attachmentId: string) => void;
  /** When provided, each row gets a "Share to chat" button (works even when disabled). */
  onShare?: (attachmentId: string) => void;
  /** When provided, openable files (docs, sheets, PDFs, images) open in the editor/viewer. */
  onOpen?: (attachmentId: string) => void;
  disabled?: boolean;
}) {
  const { currentUser } = useStore();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    // Read everything first, then hand the batch back in ONE call: a per-file
    // callback would let the parent's stale closure overwrite earlier adds.
    const added: Attachment[] = [];
    for (const file of Array.from(files)) {
      const result = await readFileAsAttachment(file, currentUser.id);
      if (result.ok) added.push(result.attachment);
      else toast.error(result.error);
    }
    if (added.length > 0) onAdd(added);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="grid gap-1.5">
      {attachments.length > 0 && (
        <div className="grid gap-1.5">
          {attachments.map((a) => (
            <AttachmentRow
              key={a.id}
              attachment={a}
              disabled={disabled}
              onRemove={() => onRemove(a.id)}
              onShare={onShare ? () => onShare(a.id) : undefined}
              onOpen={onOpen ? () => onOpen(a.id) : undefined}
            />
          ))}
        </div>
      )}
      {!disabled && (
        <>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className={cn("justify-self-start", attachments.length === 0 && "mt-0")}
          >
            <Upload className="size-3.5" />
            {busy ? "Uploading…" : "Add file"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Stored in your browser · max {formatBytes(MAX_ATTACHMENT_BYTES)} per file.
          </p>
        </>
      )}
      {disabled && attachments.length === 0 && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Paperclip className="size-3" />
          No files attached.
        </p>
      )}
    </div>
  );
}
