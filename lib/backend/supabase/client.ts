/**
 * How `SupabaseBackend` gets a client — and, just as importantly, how it
 * avoids getting one.
 *
 * `lib/supabase.ts` throws at *import time* when `NEXT_PUBLIC_SUPABASE_URL` /
 * `..._ANON_KEY` are missing. That is right for a real deployment and wrong
 * for a local-flag build or for the unit suite, which never holds
 * credentials. A static `import` anywhere in the always-loaded module graph
 * would therefore break every test in `tests/qa/` — `lib/backend/index.ts` is
 * imported by `lib/store.tsx`, which every one of those suites mounts.
 *
 * So the reference stays dynamic, exactly as `lib/auth.tsx` does it: nothing
 * under `lib/backend/supabase/` statically imports `lib/supabase.ts`, and the
 * module is only ever pulled in from inside an `async` method that a
 * `local`-flag build never calls. `lib/backend/index.ts` can then import
 * `SupabaseBackend` statically without dragging the client along.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../database.types";

export type LuminaClient = SupabaseClient<Database>;

/** Memoised so a re-mounted provider doesn't re-evaluate the module. */
let clientPromise: Promise<LuminaClient> | null = null;

export function browserClient(): Promise<LuminaClient> {
  clientPromise ??= import("../../supabase").then((m) => m.supabase);
  return clientPromise;
}
