"use client";

import * as React from "react";

import { useAuth } from "@/lib/auth";
import { backendKind } from "@/lib/backend";
import { useStore } from "@/lib/store";

/** Keeps the app store's current user in sync with the auth session.
 *  Auth owns identity; the store just follows.
 *
 *  Under the Supabase flag `session` is the signed-in user's `profiles.id`
 *  (auth resolves auth-uid → profile before publishing it, and refuses to
 *  publish a session with no profile row behind it), so the chain the plan
 *  asks for — auth uid → profile → `currentUserId` — ends here.
 *
 *  Signing out clears the store. It did not before, which was harmless while
 *  every row was fictional: the next person at the same browser would now
 *  otherwise find the previous user's real messages, tasks and projects still
 *  sitting in localStorage. `reset()` is the `Backend` operation for exactly
 *  this ("drops everything this backend holds"), reached through the store's
 *  `resetDemo`.
 *
 *  Deliberately not done on the local path: there, sign-out is a demo
 *  affordance over fictional shared data, "Reset demo data" is the explicit
 *  way to wipe it, and clearing on every sign-out would throw away the
 *  visitor's work in the public demo. */
export function SessionBridge() {
  const { session } = useAuth();
  const { currentUser, switchUser, resetDemo } = useStore();

  const wasSignedIn = React.useRef(false);

  React.useEffect(() => {
    if (session) {
      wasSignedIn.current = true;
      if (session !== currentUser.id) void switchUser(session);
      return;
    }
    // Only on the *transition* out of a session, so a first visit to the login
    // screen doesn't wipe a workspace nobody has signed into yet.
    if (!wasSignedIn.current) return;
    wasSignedIn.current = false;
    if (backendKind === "supabase") void resetDemo();
  }, [session, currentUser.id, switchUser, resetDemo]);

  return null;
}
