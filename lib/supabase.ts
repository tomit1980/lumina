import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !publishableKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local."
  );
}

/**
 * The one browser client.
 *
 * Safe to ship: the publishable key (`sb_publishable_…`, formerly the anon
 * key) grants nothing on its own — Row Level Security is the boundary. The
 * secret key never appears in this file or anywhere else under app/,
 * components/, or lib/.
 */
export const AUTH_OPTIONS = {
  persistSession: true,
  autoRefreshToken: true,
  /**
   * Read a session out of the URL when one is there.
   *
   * This was `false`, on the reasoning that "the app is a static export with
   * no OAuth redirect flow, so there is never a session to parse out of the
   * URL". True when written — the app had no sign-in path but email and
   * password — and it stopped being true the moment anybody needed a way back
   * in without their password.
   *
   * A magic link and a password-recovery link both land here with the session
   * in the URL fragment. With this off, supabase-js reads the fragment,
   * discards it, and the app shows the login screen: no error, no console
   * message, nothing to suggest a valid session was just thrown away. That is
   * what happened to the Owner's own account on the first day in production.
   *
   * It is a false setting rather than a missing feature, which is why it cost
   * an afternoon: the app looked like it had no recovery path, when in fact
   * the recovery path arrived and was ignored on the doorstep.
   */
  detectSessionInUrl: true,
} as const;

export const supabase = createClient<Database>(url, publishableKey, {
  auth: AUTH_OPTIONS,
});
