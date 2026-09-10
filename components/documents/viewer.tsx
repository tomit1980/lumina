"use client";

import { Download, File as FileIcon } from "lucide-react";

import { useAttachmentUrl } from "@/components/attachment-url";
import { DownloadLink } from "@/components/download-link";
import { Button } from "@/components/ui/button";
import type { DocumentKind } from "@/lib/documents";
import type { Attachment } from "@/lib/types";

/** Read-only display for PDFs, images and anything we can't edit. */
export function DocumentViewer({ attachment, kind }: { attachment: Attachment; kind: DocumentKind }) {
  // The viewer displays the file rather than parsing it, so it wants a URL,
  // not the bytes: a signed URL streams a 9 MB PDF straight into the iframe
  // instead of routing it through a base64 string first.
  const preview = useAttachmentUrl(attachment.dataUrl);
  const src = preview.url;
  const download = useAttachmentUrl(attachment.dataUrl, attachment.name);
  if (kind === "pdf") {
    // A `src={undefined}` iframe is a permanently blank frame with no
    // explanation — the same shape as QA-106's dead anchor. Say which of the
    // two situations it is instead.
    if (!src) {
      return (
        <div className="flex h-full items-center justify-center bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          {preview.failed
            ? `${attachment.name} couldn't be opened — the preview link couldn't be prepared.`
            : "Opening…"}
        </div>
      );
    }
    return (
      <iframe
        src={src}
        title={attachment.name}
        className="h-full w-full border-0 bg-muted/30"
      />
    );
  }
  if (kind === "image") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-muted/30 p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={attachment.name}
          className="max-h-full max-w-full rounded-lg border bg-background shadow-sm"
        />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
        <FileIcon className="size-6 text-muted-foreground" />
      </div>
      <div>
        <h2 className="text-base font-semibold">No preview for this file type</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Download it to open in another app.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <DownloadLink state={download} fileName={attachment.name}>
          <Download className="size-4" /> Download
        </DownloadLink>
      </Button>
    </div>
  );
}
