"use client";

import * as React from "react";
import QRCode from "qrcode";
import { Check, Copy } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Renders the otpauth QR plus the base32 secret for manual entry.
 *
 *  `qrCode` is a ready-made image (data URI): Supabase's `mfa.enroll()` returns
 *  one, so the Supabase path never generates a QR. The local demo path has no
 *  server to ask and passes only `uri`, which is rendered through the `qrcode`
 *  package below — that is the sole remaining use of the dependency. */
export function TwoFactorQr({
  uri,
  secret,
  qrCode,
  className,
}: {
  uri: string;
  secret: string;
  qrCode?: string;
  className?: string;
}) {
  const [generated, setGenerated] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (qrCode) return;
    let active = true;
    QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: "M" })
      .then((url) => active && setGenerated(url))
      .catch(() => active && setGenerated(null));
    return () => {
      active = false;
    };
  }, [uri, qrCode]);

  const dataUrl = qrCode ?? generated;

  const copy = () => {
    navigator.clipboard?.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // Group the secret into 4-char blocks for legibility.
  const grouped = secret.match(/.{1,4}/g)?.join(" ") ?? secret;

  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <div className="rounded-2xl border bg-white p-3">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dataUrl}
            alt="Two-factor QR code"
            width={200}
            height={200}
            className="size-[200px]"
          />
        ) : (
          <Skeleton className="size-[200px] rounded-lg" />
        )}
      </div>
      <button
        type="button"
        onClick={copy}
        className="group flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 font-mono text-xs tracking-wider transition-colors hover:bg-muted"
        aria-label="Copy setup key"
      >
        {grouped}
        {copied ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <Copy className="size-3.5 text-muted-foreground group-hover:text-foreground" />
        )}
      </button>
    </div>
  );
}
