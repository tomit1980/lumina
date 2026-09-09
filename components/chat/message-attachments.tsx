"use client";

import Link from "next/link";
import { Download, FileX2 } from "lucide-react";

import { useAttachmentUrl } from "@/components/attachment-url";
import { KindIcon } from "@/components/attachments";

import { formatBytes, resolveMessageAttachment } from "@/lib/attachments";
import { canOpen, documentKind } from "@/lib/documents";
import { fileHref, projectHref } from "@/lib/routes";
import { useStore } from "@/lib/store";
import type { MessageAttachment } from "@/lib/types";

/**
 * One file under a chat message.
 *
 * Extracted from the `.map` below for one reason: resolving a reference to a
 * URL is a hook (`useAttachmentUrl`), and a hook cannot run inside a loop
 * body. Nothing else about the rendering changed.
 */
function MessageAttachmentItem({ att }: { att: MessageAttachment }) {
  const { state } = useStore();
  const file = resolveMessageAttachment(state, att);
  const src = useAttachmentUrl(file?.dataUrl ?? "");
  const downloadHref = useAttachmentUrl(file?.dataUrl ?? "", file?.name);

  const project = att.sourceProjectId
    ? state.projects.find((p) => p.id === att.sourceProjectId)
    : undefined;
  const source = project && (
    <Link
      href={projectHref(project.id)}
      className="text-[11px] text-muted-foreground hover:underline"
    >
      from {project.emoji} {project.name}
    </Link>
  );

  if (!file) {
    return (
      <div className="flex max-w-xs items-center gap-2.5 rounded-lg border border-dashed px-2.5 py-2 text-muted-foreground">
        <FileX2 className="size-4 shrink-0" />
        <div className="min-w-0">
          <div className="truncate text-[13px] line-through">{att.name}</div>
          <div className="text-[11px]">File no longer available — removed from the project.</div>
          {source}
        </div>
      </div>
    );
  }

  if (file.type.startsWith("image/")) {
    return (
      <div className="grid max-w-sm gap-0.5">
        <a href={downloadHref} download={file.name} title={`Download ${file.name}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={file.name}
            className="max-h-64 rounded-lg border object-contain"
          />
        </a>
        <div className="flex items-center gap-2 px-0.5 text-[11px] text-muted-foreground">
          <span className="truncate">{file.name}</span>
          <span>·</span>
          <span>{formatBytes(file.size)}</span>
          {source && (
            <>
              <span>·</span>
              {source}
            </>
          )}
        </div>
      </div>
    );
  }

  const kind = documentKind(file);
  // Files that live on a project open in Lumina's editor/viewer.
  const openHref =
    att.sourceProjectId && canOpen(kind) ? fileHref(att.sourceProjectId, file.id) : null;
  const body = (
    <>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <KindIcon kind={kind} className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium group-hover:underline">
          {file.name}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span>{formatBytes(file.size)}</span>
          {source && (
            <>
              <span>·</span>
              {source}
            </>
          )}
        </div>
      </div>
    </>
  );
  const cardClass =
    "group flex max-w-xs items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2 transition-colors hover:bg-muted/60";
  return openHref ? (
    <div className={cardClass}>
      <Link
        href={openHref}
        title="Open in Lumina"
        className="flex min-w-0 flex-1 items-center gap-2.5"
      >
        {body}
      </Link>
      <a
        href={downloadHref}
        download={file.name}
        title="Download"
        aria-label={`Download ${file.name}`}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Download className="size-3.5" />
      </a>
    </div>
  ) : (
    <a href={downloadHref} download={file.name} title="Download" className={cardClass}>
      {body}
      <Download className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}

/** Files under a chat message: image previews, file cards, and a "from project"
 *  breadcrumb for files shared from a project's Files tab. */
export function MessageAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {attachments.map((att) => (
        <MessageAttachmentItem key={att.id} att={att} />
      ))}
    </div>
  );
}
