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
export const supabase = createClient<Database>(url, publishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // The app is a static export with no OAuth redirect flow, so there is
    // never a session to parse out of the URL.
    detectSessionInUrl: false,
  },
});
