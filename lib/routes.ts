"use client";

import { usePathname, useSearchParams } from "next/navigation";

/**
 * Lumina is statically exported (GitHub Pages), so resources can't live at
 * dynamic path segments like `/chat/[id]` — IDs are created at runtime and
 * can't be pre-rendered. Every resource is addressed as a static page plus an
 * `?id=` query instead. Build hrefs with these helpers; never hand-write them.
 */
export const chatHref = (id: string) => `/chat?id=${encodeURIComponent(id)}`;
export const dmHref = (id: string) => `/dm?id=${encodeURIComponent(id)}`;
export const projectHref = (id: string) => `/projects?id=${encodeURIComponent(id)}`;
/** Full-page editor/viewer for one of a project's files. */
export const fileHref = (projectId: string, attachmentId: string) =>
  `${projectHref(projectId)}&file=${encodeURIComponent(attachmentId)}`;

/** The page (`/chat`, `/dm`, `/projects`, …) and `?id=` the URL currently points at. */
export function useCurrentRoute(): {
  pathname: string;
  id: string | null;
  file: string | null;
  tab: string | null;
} {
  const raw = usePathname();
  const params = useSearchParams();
  // Normalise `/chat/` (trailingSlash export) and `/chat` to the same key.
  const pathname = raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  return {
    pathname,
    id: params.get("id"),
    file: params.get("file"),
    tab: params.get("tab"),
  };
}

/** Which section of Settings is open. A query param rather than a path
 *  segment for the same reason every other resource here uses one: this is a
 *  static export, and a dynamic segment would need a server. */
export type SettingsTab = "members" | "roles" | "statuses";

export const settingsHref = (tab: SettingsTab) => `/settings?tab=${tab}`;

/** Returns a predicate: true when the current URL is `path?id=<resourceId>`. */
export function useIsViewing() {
  const { pathname, id } = useCurrentRoute();
  return (path: string, resourceId: string) => pathname === path && id === resourceId;
}
