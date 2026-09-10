"use client";

import * as React from "react";

import type { AttachmentUrlState } from "@/components/attachment-url";
import { cn } from "@/lib/utils";

/**
 * A Download control that is honest about not being ready (QA-106).
 *
 * Every download in this app used to be `<a href={maybeUndefined}>`. React
 * omits an `undefined` href entirely, and an `<a>` without one is not a link:
 * it takes no focus, shows no pointer cursor, and clicking it does nothing at
 * all. So Download was dead for the few hundred milliseconds it takes to mint
 * a signed URL — and dead permanently if signing was refused — while looking
 * exactly like a working button. Nothing spun, nothing greyed out, nothing
 * said why.
 *
 * Three states, and the caller cannot accidentally skip one:
 *
 * - **ready** — a real anchor, exactly as before.
 * - **pending** — not a link yet. Rendered as a disabled control with
 *   `aria-busy`, so a screen reader says so and a mouse gets no false
 *   affordance.
 * - **failed** — signing was refused. Rendered disabled with a title that
 *   says the link could not be prepared, because a button that will never
 *   work should not keep pretending.
 *
 * `download` is passed through: it is ignored cross-origin, which is why
 * `useAttachmentUrl` signs with the filename, but it still matters on the
 * local demo path where the reference is a `data:` URL.
 */
export function DownloadLink({
  state,
  fileName,
  className,
  title,
  "aria-label": ariaLabel,
  children,
}: {
  state: AttachmentUrlState;
  fileName: string;
  className?: string;
  title?: string;
  "aria-label"?: string;
  children: React.ReactNode;
}) {
  if (state.url) {
    return (
      <a
        href={state.url}
        download={fileName}
        title={title}
        aria-label={ariaLabel}
        className={className}
      >
        {children}
      </a>
    );
  }

  const reason = state.failed
    ? `${fileName} can't be downloaded — the link couldn't be prepared. Reload the page to try again.`
    : `Preparing ${fileName}…`;

  return (
    <span
      role="button"
      aria-disabled="true"
      aria-busy={state.pending || undefined}
      aria-label={ariaLabel}
      title={reason}
      className={cn(className, "cursor-not-allowed opacity-50")}
    >
      {children}
    </span>
  );
}
