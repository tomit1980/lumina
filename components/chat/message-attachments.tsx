"use client";

import Link from "next/link";
import { Download, FileText, FileX2 } from "lucide-react";

import { formatBytes, resolveMessageAttachment } from "@/lib/attachments";
import { projectHref } from "@/lib/routes";
import { useStore } from "@/lib/store";
import type { MessageAttachment } from "@/lib/types";

/** Files under a chat message: image previews, file cards, and a "from project"
 *  breadcrumb for files shared from a project's Files tab. */
export function MessageAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  const { state } = useStore();

  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {attachments.map((att) => {
        const file = resolveMessageAttachment(state, att);
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
            <div
              key={att.id}
              className="flex max-w-xs items-center gap-2.5 rounded-lg border border-dashed px-2.5 py-2 text-muted-foreground"
            >
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
            <div key={att.id} className="grid max-w-sm gap-0.5">
              <a href={file.dataUrl} download={file.name} title={`Download ${file.name}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={file.dataUrl}
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

        return (
          <a
            key={att.id}
            href={file.dataUrl}
            download={file.name}
            title="Download"
            className="group flex max-w-xs items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2 transition-colors hover:bg-muted/60"
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
              <FileText className="size-4 text-muted-foreground" />
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
            <Download className="size-3.5 shrink-0 text-muted-foreground" />
          </a>
        );
      })}
    </div>
  );
}
