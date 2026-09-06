"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** Six-digit numeric code field with monospace, spaced-out digits. */
export function OtpInput({
  value,
  onChange,
  onComplete,
  autoFocus,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const handle = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    onChange(digits);
    if (digits.length === 6) onComplete?.(digits);
  };

  return (
    <input
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={6}
      autoFocus={autoFocus}
      disabled={disabled}
      value={value}
      onChange={(e) => handle(e.target.value)}
      placeholder="••••••"
      aria-label="6-digit verification code"
      className={cn(
        "h-12 w-full rounded-xl border bg-background text-center font-mono text-2xl tracking-[0.5em] outline-none transition-shadow",
        "placeholder:tracking-[0.4em] placeholder:text-muted-foreground/40",
        "focus:ring-2 focus:ring-ring/50 disabled:opacity-50",
        invalid && "border-destructive focus:ring-destructive/40"
      )}
    />
  );
}
