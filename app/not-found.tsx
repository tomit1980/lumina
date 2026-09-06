"use client";

import Link from "next/link";
import { Compass } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Exported as `404.html`, which GitHub Pages serves for any unknown path. */
export default function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
        <Compass className="size-6 text-muted-foreground" />
      </div>
      <div>
        <h2 className="text-base font-semibold">Page not found</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          That link doesn&apos;t go anywhere in Lumina.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/">Back home</Link>
      </Button>
    </div>
  );
}
