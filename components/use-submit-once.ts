"use client";

import * as React from "react";

/**
 * Runs a submit handler at most once at a time (QA-126).
 *
 * Every create/save dialog was an async handler with no in-flight state. On
 * the local demo backend the round trip is a resolved promise and the window
 * is sub-millisecond, so nothing showed; on Supabase it is a real network
 * call, and a double-click or a held Enter created two projects, two channels,
 * two tasks or two roles. `NewFileDialog` in app/projects/page.tsx was the one
 * dialog that already guarded it, which is why the pattern is lifted here
 * rather than invented: four copies of the same three lines is how they drift.
 *
 * The guard is a ref, not the state flag, and that distinction is the whole
 * point: a second click can arrive in the same tick as the first, before
 * React has re-rendered with `pending: true`, so a state-only guard would
 * still let both through. The state exists purely so the button can show
 * itself as busy.
 *
 * Returns the wrapped handler and whether it is in flight.
 */
export function useSubmitOnce<A extends unknown[]>(
  fn: (...args: A) => void | Promise<void>
): readonly [(...args: A) => Promise<void>, boolean] {
  const inFlight = React.useRef(false);
  const [pending, setPending] = React.useState(false);
  // Kept in a ref so the returned callback is stable and always calls the
  // latest closure — a dialog's handler closes over its form state and is a
  // different function on every render.
  const latest = React.useRef(fn);
  latest.current = fn;

  const run = React.useCallback(async (...args: A) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await latest.current(...args);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  return [run, pending] as const;
}
