/**
 * The one copy of the presence dot colour and label. Task 4's brief: this was
 * duplicated in `components/user-avatar.tsx`, `components/user-card.tsx` and
 * `components/chat/dm-view.tsx` — three places a fourth presence state, or a
 * new colour, would have had to be kept in sync by hand. Every consumer
 * imports from here instead.
 *
 * `Presence` (`lib/types.ts`) is still `"online" | "away" | "offline"`, and
 * both maps still cover all three: nothing SETS "away" any more (presence now
 * comes only from `{ kind: "presence" }` events — see `lib/store.tsx`'s apply
 * core — which never emits it), but the type itself is left alone rather than
 * churned for its own sake, so these stay total over it.
 */
import type { Presence } from "./types";

export const PRESENCE_DOT: Record<Presence, string> = {
  online: "bg-emerald-500",
  away: "bg-amber-400",
  offline: "bg-zinc-300 dark:bg-zinc-600",
};

export const PRESENCE_LABEL: Record<Presence, string> = {
  online: "Online",
  away: "Away",
  offline: "Offline",
};
