"use client";

import { useStore } from "@/lib/store";

/**
 * The visible half of Task 5: while `lib/store.tsx`'s `connected` flag is
 * `true` — the normal case, and the only state a `LocalBackend` session
 * ever has — this renders `null`, so nothing about the screen changes.
 *
 * It exists for the other case, and only that case: the socket has stopped
 * receiving anything, so whatever changed elsewhere while it was down is
 * invisible until it reconnects and reloads (see the apply core's
 * `"connection"` case). A quiet strip saying so is honest; staying silent
 * while the workspace looks live but is not would be the exact lie the
 * brief calls worse than looking offline, because people act on what they
 * see. So this stays a status line, not an alarm: no motion, no sound, no
 * dialog stealing focus — just text, gone the instant `connected` flips
 * back.
 */
export function ConnectionStatus() {
  const { connected } = useStore();
  if (connected) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-amber-500 px-3 py-1 text-xs font-medium text-white"
    >
      Reconnecting…
    </div>
  );
}
