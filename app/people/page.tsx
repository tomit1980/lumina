"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { settingsHref } from "@/lib/routes";

/**
 * People moved into Settings.
 *
 * Kept as a redirect rather than deleted: the sidebar and the command palette
 * were not the only things pointing here — a bookmark, a shared link or a
 * message from last week still says `/people`, and a 404 would be a worse
 * answer than the page they wanted. `replace`, not `push`, so Back does not
 * bounce them straight into the redirect again.
 */
export default function PeoplePage() {
  const router = useRouter();
  React.useEffect(() => {
    router.replace(settingsHref("members"));
  }, [router]);
  return null;
}
