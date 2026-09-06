"use client";

import * as React from "react";

import { useAuth } from "@/lib/auth";
import { useStore } from "@/lib/store";

/** Keeps the app store's current user in sync with the auth session.
 *  Auth owns identity; the store just follows. */
export function SessionBridge() {
  const { session } = useAuth();
  const { currentUser, switchUser } = useStore();

  React.useEffect(() => {
    if (session && session !== currentUser.id) switchUser(session);
  }, [session, currentUser.id, switchUser]);

  return null;
}
